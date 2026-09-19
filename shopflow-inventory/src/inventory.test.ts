import assert from "node:assert/strict";
import test from "node:test";
import { InventoryService, type InventoryRepository, type Product } from "./inventory.js";

class MemoryInventory implements InventoryRepository {
  product: Product = { id: "prod-a", sku: "SKU-A", name: "Product A", priceCents: 1500, stock: 10 };
  list() { return [{ ...this.product }]; }
  get(id: string) { return id === this.product.id ? { ...this.product } : undefined; }
  decrement(id: string, quantity: number) {
    if (id !== this.product.id || this.product.stock < quantity) return undefined;
    this.product.stock -= quantity;
    return { ...this.product };
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
