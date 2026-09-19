import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { InventoryDatabase } from "./database.js";
import { InventoryService, type InventoryRepository, type Product } from "./inventory.js";

class MemoryInventory implements InventoryRepository {
  product: Product = { id: "prod-a", sku: "SKU-A", name: "Product A", priceCents: 1500, stock: 10 };
  readonly restorations = new Map<string, { productId: string; quantity: number; appliedAt: string }>();
  list() { return [{ ...this.product }]; }
  get(id: string) { return id === this.product.id ? { ...this.product } : undefined; }
  decrement(id: string, quantity: number) {
    if (id !== this.product.id || this.product.stock < quantity) return undefined;
    this.product.stock -= quantity;
    return { ...this.product };
  }
  applyRestoration(key: string, productId: string, quantity: number, appliedAt: string) {
    if (productId !== this.product.id) return undefined;
    if (this.restorations.has(key)) return { product: { ...this.product }, applied: false };
    this.restorations.set(key, { productId, quantity, appliedAt });
    this.product.stock += quantity;
    return { product: { ...this.product }, applied: true };
  }
}

function failure(run: () => unknown): { status?: number; message?: string } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as { status?: number; message?: string };
  }
}

type RestorationRow = { key: string; product_id: string; quantity: number; applied_at: string };

function restorationRows(path: string, key: string): RestorationRow[] {
  const connection = new DatabaseSync(path);
  try {
    return connection
      .prepare("SELECT key, product_id, quantity, applied_at FROM stock_restorations WHERE key = ?")
      .all(key) as RestorationRow[];
  } finally {
    connection.close();
  }
}

test("validates then atomically decrements available stock", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);
  assert.equal(service.validate("prod-a", 3).available, true);
  assert.equal(service.decrement("prod-a", 3).stock, 7);
});

test("rejects insufficient stock without changing inventory", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);
  assert.throws(() => service.decrement("prod-a", 11), /Insufficient stock/);
  assert.equal(repository.product.stock, 10);
});

test("rejects non-positive and fractional quantities", () => {
  const service = new InventoryService(new MemoryInventory());
  for (const quantity of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => service.validate("prod-a", quantity), /positive integer/);
  }
});

test("applies a restoration once per idempotency key and deduplicates repeats", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);

  assert.equal(service.restore("prod-a", 5, "order-cancel:1").stock, 15);
  assert.equal(repository.restorations.size, 1);

  // A repeat of the same key is a successful no-op that reports the current stock.
  assert.equal(service.restore("prod-a", 5, "order-cancel:1").stock, 15);
  assert.equal(repository.restorations.size, 1);
  assert.equal(repository.restorations.get("order-cancel:1")?.quantity, 5);

  // A different key increments again.
  assert.equal(service.restore("prod-a", 2, "order-cancel:2").stock, 17);
  assert.equal(repository.restorations.size, 2);
});

test("keeps the first applied amount when a key is retried with another quantity", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);

  assert.equal(service.restore("prod-a", 3, "order-cancel:4").stock, 13);
  assert.equal(service.restore("prod-a", 99, "order-cancel:4").stock, 13);
  assert.equal(repository.restorations.size, 1);
  assert.equal(repository.restorations.get("order-cancel:4")?.quantity, 3);
});

test("returns 404 for an unknown product without incrementing or recording a key", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);

  const unknown = failure(() => service.restore("nope", 1, "order-cancel:5"));
  assert.equal(unknown?.status, 404);
  assert.match(unknown?.message ?? "", /Product not found/);
  assert.equal(repository.product.stock, 10);
  assert.equal(repository.restorations.size, 0);

  // A real application with a different key after the failed attempt still increments exactly once.
  assert.equal(service.restore("prod-a", 5, "order-cancel:3").stock, 15);
  assert.equal(repository.restorations.size, 1);
});

test("rejects invalid restore quantities without incrementing or recording a key", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);

  for (const quantity of [0, -1, 1.5, Number.NaN]) {
    const invalid = failure(() => service.restore("prod-a", quantity, "order-cancel:7"));
    assert.equal(invalid?.status, 400);
    assert.match(invalid?.message ?? "", /positive integer/);
  }
  assert.equal(repository.product.stock, 10);
  assert.equal(repository.restorations.size, 0);
});

test("rejects a missing or blank idempotency key without incrementing or recording", () => {
  const repository = new MemoryInventory();
  const service = new InventoryService(repository);

  for (const key of ["", "   "]) {
    const invalid = failure(() => service.restore("prod-a", 1, key));
    assert.equal(invalid?.status, 400);
    assert.match(invalid?.message ?? "", /idempotency key is required/);
  }
  assert.equal(repository.product.stock, 10);
  assert.equal(repository.restorations.size, 0);
});

test("persists exactly-once restorations against a real SQLite database", () => {
  const directory = mkdtempSync(join(tmpdir(), "shopflow-inventory-"));
  const path = join(directory, "inventory.db");
  const databases: InventoryDatabase[] = [];
  const openService = () => {
    const database = new InventoryDatabase(path);
    databases.push(database);
    return new InventoryService(database);
  };
  const closeAll = () => {
    while (databases.length > 0) (databases.pop() as InventoryDatabase).close();
  };
  const service = openService();
  try {
    assert.equal(service.get("prod-a").stock, 20);

    // Rows 1 and 2: the first key applies once (20 -> 21); the repeat is a deduplicated no-op.
    assert.equal(service.restore("prod-a", 1, "order-cancel:1").stock, 21);
    assert.equal(service.restore("prod-a", 1, "order-cancel:1").stock, 21);
    assert.equal(restorationRows(path, "order-cancel:1").length, 1);

    // Row 3: a new key increments again (21 -> 23).
    assert.equal(service.restore("prod-a", 2, "order-cancel:2").stock, 23);

    // Row 6: an unknown product is rejected, leaves stock untouched and creates no key row.
    assert.throws(() => service.restore("nope", 1, "order-cancel:5"), /Product not found/);
    assert.equal(service.get("prod-a").stock, 23);
    assert.equal(restorationRows(path, "order-cancel:5").length, 0);

    // Row 4: only a real application increments; prod-b is restored with its own key.
    assert.equal(service.restore("prod-b", 5, "order-cancel:3").stock, 15);

    // Row 5: the first applied amount wins for a repeated key.
    assert.equal(service.restore("prod-a", 3, "order-cancel:4").stock, 26);
    assert.equal(service.restore("prod-a", 99, "order-cancel:4").stock, 26);
    const applied = restorationRows(path, "order-cancel:4");
    assert.equal(applied.length, 1);
    assert.equal(applied[0].product_id, "prod-a");
    assert.equal(applied[0].quantity, 3);
    assert.ok(!Number.isNaN(Date.parse(applied[0].applied_at)));

    // The restoration rows and the increments are committed together and survive a fresh connection.
    closeAll();
    const verification = new DatabaseSync(path);
    try {
      assert.equal((verification.prepare("SELECT COUNT(*) AS count FROM stock_restorations").get() as { count: number }).count, 4);
      assert.equal((verification.prepare("SELECT stock FROM products WHERE id = 'prod-a'").get() as { stock: number }).stock, 26);
      assert.equal((verification.prepare("SELECT stock FROM products WHERE id = 'prod-b'").get() as { stock: number }).stock, 15);
    } finally {
      verification.close();
    }

    // A retry that arrives after a restart still converges: the key stays deduplicated.
    const restarted = openService();
    assert.equal(restarted.get("prod-a").stock, 26);
    assert.equal(restarted.restore("prod-a", 1, "order-cancel:1").stock, 26);
    assert.equal(restarted.restore("prod-a", 1, "order-cancel:1").stock, 26);
    assert.equal(restorationRows(path, "order-cancel:1").length, 1);
  } finally {
    closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});
