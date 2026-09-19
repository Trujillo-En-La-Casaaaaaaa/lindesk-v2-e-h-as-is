import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OrderDatabase } from "./database.js";
import {
  OrderService, inventoryRestoreKey,
  type InventoryPort, type NotificationPort, type Order, type OrderRepository,
} from "./orders.js";

class MemoryOrders implements OrderRepository {
  items = new Map<string, Order>();
  create(order: Order) { this.items.set(order.id, order); return order; }
  get(id: string) { return this.items.get(id); }
  markShipped(id: string) {
    const order = this.items.get(id);
    if (!order || order.status !== "CONFIRMED") return undefined;
    const shipped: Order = { ...order, status: "SHIPPED" };
    this.items.set(id, shipped);
    return shipped;
  }
  markCancelled(id: string, changes: { cancelledAt: string; cancellationReason: string }) {
    const order = this.items.get(id);
    if (!order || order.status !== "CONFIRMED") return undefined;
    const cancelled: Order = {
      ...order,
      status: "CANCELLED",
      cancelledAt: changes.cancelledAt,
      cancellationReason: changes.cancellationReason,
      inventoryRestoreState: "PENDING",
    };
    this.items.set(id, cancelled);
    return cancelled;
  }
  setInventoryRestoreState(id: string, state: "DONE") {
    const order = this.items.get(id);
    if (order) this.items.set(id, { ...order, inventoryRestoreState: state });
  }
  setCancellationNotifiedAt(id: string, at: string) {
    const order = this.items.get(id);
    if (order) this.items.set(id, { ...order, cancellationNotifiedAt: at });
  }
  listPendingCancellations() {
    return [...this.items.values()].filter((order) =>
      order.status === "CANCELLED" &&
      (order.inventoryRestoreState === "PENDING" || !order.cancellationNotifiedAt));
  }
  remove(id: string) { this.items.delete(id); }
}

class FakeInventory implements InventoryPort {
  readonly restores: { productId: string; quantity: number; idempotencyKey: string }[] = [];
  readonly appliedQuantity = new Map<string, number>();
  restoreCalls = 0;
  restoreFailures = 0;
  decrementFailures = 0;
  constructor(private readonly calls: string[]) {}
  async validate() { this.calls.push("validate"); return { product: { priceCents: 1500 } }; }
  async decrement() {
    this.calls.push("decrement");
    if (this.decrementFailures > 0) { this.decrementFailures -= 1; throw new Error("race"); }
  }
  async restore(productId: string, quantity: number, idempotencyKey: string) {
    this.calls.push("restore");
    this.restoreCalls += 1;
    this.restores.push({ productId, quantity, idempotencyKey });
    if (this.restoreFailures > 0) {
      this.restoreFailures -= 1;
      throw Object.assign(new Error("restore unavailable"), { status: 502 });
    }
    if (!this.appliedQuantity.has(idempotencyKey)) this.appliedQuantity.set(idempotencyKey, quantity);
  }
}

class FakeNotifications implements NotificationPort {
  readonly cancellations: { orderId: string; customerEmail: string; reason: string }[] = [];
  cancellationCalls = 0;
  cancellationFailures = 0;
  constructor(private readonly calls: string[]) {}
  async orderConfirmation() { this.calls.push("notify"); }
  async orderCancellation(order: Order, reason: string) {
    this.calls.push("cancellation-notify");
    this.cancellationCalls += 1;
    if (this.cancellationFailures > 0) {
      this.cancellationFailures -= 1;
      throw Object.assign(new Error("provider failed"), { status: 502 });
    }
    if (!this.cancellations.some((message) => message.orderId === order.id)) {
      this.cancellations.push({ orderId: order.id, customerEmail: order.customerEmail, reason });
    }
  }
}

type FixtureOptions = { decrementFails?: boolean; ids?: string[]; times?: string[] };

function fixture(decrementFailsOrOptions: boolean | FixtureOptions = false) {
  const options: FixtureOptions = typeof decrementFailsOrOptions === "boolean"
    ? { decrementFails: decrementFailsOrOptions }
    : decrementFailsOrOptions;
  const calls: string[] = [];
  const inventory = new FakeInventory(calls);
  if (options.decrementFails) inventory.decrementFailures = 1;
  const notifications = new FakeNotifications(calls);
  const repository = new MemoryOrders();
  const ids = options.ids ?? ["order-1"];
  const times = options.times ?? ["2026-01-01T00:00:00.000Z"];
  let idCursor = 0;
  let timeCursor = 0;
  const service = new OrderService(
    repository, inventory, notifications,
    () => ids[Math.min(idCursor++, ids.length - 1)],
    () => times[Math.min(timeCursor++, times.length - 1)],
  );
  return { service, repository, inventory, notifications, calls };
}

async function confirmed(service: OrderService, quantity = 1): Promise<Order> {
  return await service.create({ productId: "prod-a", quantity, customerEmail: "buyer@example.com" });
}

function expects(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, status);
    assert.match((error as Error).message, message);
    return true;
  };
}

test("validates inventory before persistence, decrements after creation, then notifies", async () => {
  const { service, calls } = fixture();
  const order = await service.create({ productId: "prod-a", quantity: 2, customerEmail: "buyer@example.com" });
  assert.equal(order.totalCents, 3000);
  assert.deepEqual(calls, ["validate", "decrement", "notify"]);
  assert.equal(service.get(order.id).status, "CONFIRMED");
});

test("removes the new order if atomic stock decrement loses a race", async () => {
  const { service, repository } = fixture(true);
  await assert.rejects(
    service.create({ productId: "prod-a", quantity: 1, customerEmail: "buyer@example.com" }),
    /race/
  );
  assert.equal(repository.items.size, 0);
});

test("ships a confirmed order once", async () => {
  const { service } = fixture();
  const order = await service.create({ productId: "prod-a", quantity: 1, customerEmail: "buyer@example.com" });
  assert.equal(service.ship(order.id).status, "SHIPPED");
  assert.throws(() => service.ship(order.id), /cannot be shipped/);
});

test("cancels a confirmed order, restoring inventory before notifying", async () => {
  const f = fixture();
  const order = await confirmed(f.service, 2);

  const cancelled = await f.service.cancel(order.id, "Changed my mind");

  assert.equal(cancelled.id, order.id);
  assert.equal(cancelled.status, "CANCELLED");
  assert.ok(cancelled.cancelledAt);
  assert.equal(cancelled.cancellationReason, "Changed my mind");
  assert.equal(cancelled.inventoryRestoreState, "DONE");
  assert.ok(cancelled.cancellationNotifiedAt);
  assert.deepEqual(f.inventory.restores, [
    { productId: "prod-a", quantity: 2, idempotencyKey: `order-cancel:${order.id}` },
  ]);
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 2);
  assert.deepEqual(f.notifications.cancellations, [
    { orderId: order.id, customerEmail: "buyer@example.com", reason: "Changed my mind" },
  ]);
  // restore is ordered before the notification
  assert.deepEqual(f.calls.slice(-2), ["restore", "cancellation-notify"]);
  assert.deepEqual(f.repository.listPendingCancellations(), []);
});

test("trims the cancellation reason before recording it", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  const cancelled = await f.service.cancel(order.id, "  Changed my mind  ");
  assert.equal(cancelled.cancellationReason, "Changed my mind");
});

test("rejects blank or missing cancellation reasons without changing the order", async () => {
  for (const reason of ["", "   ", null, undefined]) {
    const f = fixture();
    const order = await confirmed(f.service);

    await assert.rejects(f.service.cancel(order.id, reason as unknown as string), expects(400, /reason is required/));

    const stored = f.service.get(order.id);
    assert.equal(stored.status, "CONFIRMED");
    assert.equal(stored.cancelledAt, null);
    assert.equal(stored.cancellationReason, null);
    assert.equal(stored.inventoryRestoreState, "NOT_REQUIRED");
    assert.equal(f.inventory.restores.length, 0);
    assert.equal(f.notifications.cancellations.length, 0);
  }
});

test("bounds the cancellation reason at 200 characters", async () => {
  const accepted = fixture();
  const order = await confirmed(accepted.service);
  const twoHundred = "r".repeat(200);
  assert.equal((await accepted.service.cancel(order.id, twoHundred)).cancellationReason, twoHundred);

  const rejected = fixture();
  const other = await confirmed(rejected.service);
  await assert.rejects(rejected.service.cancel(other.id, "r".repeat(201)), expects(400, /200 characters or fewer/));
  assert.equal(rejected.service.get(other.id).status, "CONFIRMED");
  assert.equal(rejected.inventory.restores.length, 0);
  assert.equal(rejected.notifications.cancellations.length, 0);
});

test("reports an unknown order as 404 and validates the reason first", async () => {
  const f = fixture();
  await assert.rejects(f.service.cancel("missing", "Changed my mind"), expects(404, /Order not found/));
  await assert.rejects(f.service.cancel("missing", "   "), expects(400, /reason is required/));
  assert.equal(f.inventory.restores.length, 0);
  assert.equal(f.notifications.cancellations.length, 0);
});

test("rejects cancelling a shipped order", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  f.service.ship(order.id);

  await assert.rejects(f.service.cancel(order.id, "Changed my mind"), expects(409, /after shipping/));

  const stored = f.service.get(order.id);
  assert.equal(stored.status, "SHIPPED");
  assert.equal(stored.cancelledAt, null);
  assert.equal(stored.cancellationReason, null);
  assert.equal(f.inventory.restores.length, 0);
  assert.equal(f.notifications.cancellations.length, 0);
});

test("cancelling the same order twice returns the same order and compensates once", async () => {
  const f = fixture();
  const order = await confirmed(f.service);

  const first = await f.service.cancel(order.id, "Changed my mind");
  const second = await f.service.cancel(order.id, "Changed my mind");

  assert.deepEqual(second, first);
  assert.equal(second.status, "CANCELLED");
  assert.equal(f.inventory.restores.length, 1);
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 1);
  assert.equal(f.notifications.cancellations.length, 1);
  assert.equal(f.repository.get(order.id)!.status, "CANCELLED");
  assert.equal(f.repository.get(order.id)!.inventoryRestoreState, "DONE");
  assert.deepEqual(f.repository.listPendingCancellations(), []);
});

test("concurrent cancellations of one order claim the transition once", async () => {
  const f = fixture();
  const order = await confirmed(f.service);

  const [a, b] = await Promise.all([
    f.service.cancel(order.id, "Changed my mind"),
    f.service.cancel(order.id, "Changed my mind"),
  ]);

  assert.equal(a.status, "CANCELLED");
  assert.equal(b.status, "CANCELLED");
  assert.ok(f.inventory.restores.every((call) => call.idempotencyKey === inventoryRestoreKey(order.id)));
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 1);
  assert.equal(f.notifications.cancellations.length, 1);
  assert.equal(f.repository.get(order.id)!.inventoryRestoreState, "DONE");
});

test("keeps the cancellation durable when the inventory restore fails, then completes on retry", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  f.inventory.restoreFailures = 1;

  await assert.rejects(f.service.cancel(order.id, "Changed my mind"), expects(502, /completion is pending/));

  const pending = f.repository.get(order.id)!;
  assert.equal(pending.status, "CANCELLED");
  assert.equal(pending.cancelledAt, "2026-01-01T00:00:00.000Z");
  assert.equal(pending.inventoryRestoreState, "PENDING");
  assert.equal(pending.cancellationNotifiedAt, null);
  assert.equal(f.notifications.cancellationCalls, 0);
  assert.deepEqual(f.repository.listPendingCancellations().map((item) => item.id), [order.id]);

  const completed = await f.service.cancel(order.id, "Changed my mind");

  assert.equal(completed.status, "CANCELLED");
  assert.equal(completed.cancellationReason, "Changed my mind");
  assert.equal(completed.inventoryRestoreState, "DONE");
  assert.ok(completed.cancellationNotifiedAt);
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 1);
  assert.equal(f.notifications.cancellations.length, 1);
  assert.deepEqual(f.repository.listPendingCancellations(), []);
});

test("does not report success while the cancellation notification is outstanding", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  f.notifications.cancellationFailures = 1;

  await assert.rejects(f.service.cancel(order.id, "Changed my mind"), expects(502, /completion is pending/));

  const pending = f.repository.get(order.id)!;
  assert.equal(pending.status, "CANCELLED");
  assert.equal(pending.inventoryRestoreState, "DONE");
  assert.equal(pending.cancellationNotifiedAt, null);
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 1);

  const retried = await f.service.cancel(order.id, "Changed my mind");

  assert.ok(retried.cancellationNotifiedAt);
  assert.equal(f.inventory.restores.length, 1);
  assert.equal(f.notifications.cancellations.length, 1);
  assert.deepEqual(f.repository.listPendingCancellations(), []);
});

test("reconcileCancellations drives the compensation of a pending cancellation", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  f.inventory.restoreFailures = 1;
  await assert.rejects(f.service.cancel(order.id, "Changed my mind"), expects(502, /completion is pending/));
  assert.deepEqual(f.repository.listPendingCancellations().map((item) => item.id), [order.id]);

  assert.equal(await f.service.reconcileCancellations(), 1);

  const done = f.repository.get(order.id)!;
  assert.equal(done.inventoryRestoreState, "DONE");
  assert.ok(done.cancellationNotifiedAt);
  assert.deepEqual(f.notifications.cancellations, [
    { orderId: order.id, customerEmail: "buyer@example.com", reason: "Changed my mind" },
  ]);
  assert.equal(f.inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 1);
  // a second pass has nothing left to do
  assert.equal(await f.service.reconcileCancellations(), 0);
});

test("reconciliation leaves an order pending while the downstream is still failing", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  f.inventory.restoreFailures = 10;
  await assert.rejects(f.service.cancel(order.id, "Changed my mind"), expects(502, /completion is pending/));

  assert.equal(await f.service.reconcileCancellations(), 0);
  assert.equal(f.repository.get(order.id)!.inventoryRestoreState, "PENDING");
  assert.equal(f.repository.get(order.id)!.cancellationNotifiedAt, null);
  assert.deepEqual(f.repository.listPendingCancellations().map((item) => item.id), [order.id]);

  f.inventory.restoreFailures = 0;
  assert.equal(await f.service.reconcileCancellations(), 1);
  assert.equal(f.repository.get(order.id)!.inventoryRestoreState, "DONE");
  assert.ok(f.repository.get(order.id)!.cancellationNotifiedAt);
});

test("a cancelled order stays terminal", async () => {
  const f = fixture();
  const order = await confirmed(f.service);
  await f.service.cancel(order.id, "Changed my mind");
  assert.throws(() => f.service.ship(order.id), /cannot be shipped/);
  assert.equal(f.service.get(order.id).status, "CANCELLED");
});

const LEGACY_SCHEMA = `CREATE TABLE orders (
  id TEXT PRIMARY KEY, customer_email TEXT NOT NULL, product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL, total_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED', 'SHIPPED')), created_at TEXT NOT NULL
)`;

function temporaryDatabase(): { directory: string; path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "shopflow-orders-"));
  const path = join(directory, "orders.db");
  return {
    directory,
    path,
    cleanup: () => {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows may still hold the SQLite file; the temporary directory is left behind.
      }
    },
  };
}

test("migrates a database stored with the legacy schema without losing rows", () => {
  const temp = temporaryDatabase();
  try {
    const legacy = new DatabaseSync(temp.path);
    legacy.exec(LEGACY_SCHEMA);
    const insert = legacy.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("legacy-1", "buyer@example.com", "prod-a", 2, 3000, "CONFIRMED", "2025-12-31T00:00:00.000Z");
    insert.run("legacy-2", "buyer@example.com", "prod-a", 1, 1500, "SHIPPED", "2025-12-31T00:00:00.000Z");
    legacy.close();

    const database = new OrderDatabase(temp.path);

    const kept = database.get("legacy-1")!;
    assert.equal(kept.id, "legacy-1");
    assert.equal(kept.status, "CONFIRMED");
    assert.equal(kept.quantity, 2);
    assert.equal(kept.totalCents, 3000);
    assert.equal(kept.createdAt, "2025-12-31T00:00:00.000Z");
    assert.equal(kept.cancelledAt, null);
    assert.equal(kept.cancellationReason, null);
    assert.equal(kept.inventoryRestoreState, "NOT_REQUIRED");
    assert.equal(kept.cancellationNotifiedAt, null);
    assert.equal(database.get("legacy-2")!.status, "SHIPPED");
    assert.deepEqual(database.listPendingCancellations(), []);

    // the status CHECK now accepts CANCELLED
    const claimed = database.markCancelled("legacy-1", {
      cancelledAt: "2026-01-01T00:00:00.000Z",
      cancellationReason: "Changed my mind",
    })!;
    assert.equal(claimed.status, "CANCELLED");
    assert.equal(claimed.inventoryRestoreState, "PENDING");
    database.setInventoryRestoreState("legacy-1", "DONE");
    database.setCancellationNotifiedAt("legacy-1", "2026-01-01T00:00:01.000Z");
    assert.deepEqual(database.listPendingCancellations(), []);

    // reopening the migrated database must be a no-op that keeps every row
    const reopened = new OrderDatabase(temp.path);
    const migrated = reopened.get("legacy-1")!;
    assert.equal(migrated.status, "CANCELLED");
    assert.equal(migrated.cancellationReason, "Changed my mind");
    assert.equal(migrated.inventoryRestoreState, "DONE");
    assert.equal(migrated.cancellationNotifiedAt, "2026-01-01T00:00:01.000Z");
    assert.equal(reopened.get("legacy-2")!.status, "SHIPPED");
  } finally {
    temp.cleanup();
  }
});

test("persists and claims cancellation state in a fresh database", () => {
  const temp = temporaryDatabase();
  try {
    const database = new OrderDatabase(temp.path);
    const base: Order = {
      id: "order-1",
      customerEmail: "buyer@example.com",
      productId: "prod-a",
      quantity: 1,
      totalCents: 1500,
      status: "CONFIRMED",
      createdAt: "2026-01-01T00:00:00.000Z",
      cancelledAt: null,
      cancellationReason: null,
      inventoryRestoreState: "NOT_REQUIRED",
      cancellationNotifiedAt: null,
    };
    assert.deepEqual(database.create(base), base);
    assert.deepEqual(database.get("order-1"), base);
    assert.deepEqual(database.listPendingCancellations(), []);

    assert.equal(database.markShipped("order-1")!.status, "SHIPPED");
    assert.equal(database.markShipped("order-1"), undefined);
    assert.equal(database.markCancelled("order-1", { cancelledAt: "x", cancellationReason: "y" }), undefined);

    database.create({ ...base, id: "order-2" });
    const claimed = database.markCancelled("order-2", {
      cancelledAt: "2026-01-02T00:00:00.000Z",
      cancellationReason: "Changed my mind",
    })!;
    assert.equal(claimed.status, "CANCELLED");
    assert.equal(claimed.cancelledAt, "2026-01-02T00:00:00.000Z");
    assert.equal(claimed.cancellationReason, "Changed my mind");
    assert.equal(claimed.inventoryRestoreState, "PENDING");
    assert.equal(claimed.cancellationNotifiedAt, null);

    // the claim is conditional: a second claim changes nothing
    assert.equal(database.markCancelled("order-2", { cancelledAt: "later", cancellationReason: "other" }), undefined);
    assert.equal(database.get("order-2")!.cancellationReason, "Changed my mind");
    assert.deepEqual(database.listPendingCancellations().map((order) => order.id), ["order-2"]);

    database.setInventoryRestoreState("order-2", "DONE");
    assert.equal(database.get("order-2")!.inventoryRestoreState, "DONE");
    assert.deepEqual(database.listPendingCancellations().map((order) => order.id), ["order-2"]);

    database.setCancellationNotifiedAt("order-2", "2026-01-03T00:00:00.000Z");
    assert.equal(database.get("order-2")!.cancellationNotifiedAt, "2026-01-03T00:00:00.000Z");
    assert.deepEqual(database.listPendingCancellations(), []);

    database.remove("order-2");
    assert.equal(database.get("order-2"), undefined);
    assert.equal(database.get("order-1")!.status, "SHIPPED");
  } finally {
    temp.cleanup();
  }
});

test("drives a cancellation end to end through the SQLite adapter", async () => {
  const temp = temporaryDatabase();
  try {
    const database = new OrderDatabase(temp.path);
    const calls: string[] = [];
    const inventory = new FakeInventory(calls);
    const notifications = new FakeNotifications(calls);
    const service = new OrderService(
      database, inventory, notifications,
      () => "order-1",
      () => "2026-01-01T00:00:00.000Z",
    );

    const order = await confirmed(service, 3);
    const cancelled = await service.cancel(order.id, "Changed my mind");

    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancellationReason, "Changed my mind");
    assert.deepEqual(database.get(order.id), cancelled);
    assert.equal(database.get(order.id)!.inventoryRestoreState, "DONE");
    assert.ok(database.get(order.id)!.cancellationNotifiedAt);
    assert.deepEqual(database.listPendingCancellations(), []);
    assert.equal(inventory.appliedQuantity.get(inventoryRestoreKey(order.id)), 3);
    assert.equal(notifications.cancellations.length, 1);
  } finally {
    temp.cleanup();
  }
});

type StubState = {
  requests: { path: string; body: Record<string, unknown> }[];
  restoreKeys: string[];
  appliedRestoreKeys: string[];
  cancellations: { orderId: string; customerEmail: string; reason: string }[];
  confirmations: number;
  failNextRestoreStatus: number | null;
};

async function startStub() {
  const state: StubState = {
    requests: [],
    restoreKeys: [],
    appliedRestoreKeys: [],
    cancellations: [],
    confirmations: 0,
    failNextRestoreStatus: null,
  };
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    const path = req.url ?? "";
    state.requests.push({ path, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (path === "/inventory/validate") {
      return send(200, { product: { id: body.productId, priceCents: 1500, stock: 10 } });
    }
    if (path === "/inventory/decrement") {
      return send(200, { product: { id: body.productId, priceCents: 1500, stock: 9 } });
    }
    if (path === "/inventory/restore") {
      const key = String(body.idempotencyKey ?? "");
      state.restoreKeys.push(key);
      if (state.failNextRestoreStatus !== null) {
        const status = state.failNextRestoreStatus;
        state.failNextRestoreStatus = null;
        return send(status, { error: "restore unavailable" });
      }
      state.appliedRestoreKeys.push(key);
      return send(200, { product: { id: body.productId, priceCents: 1500, stock: 11 } });
    }
    if (path === "/notifications/order-confirmation") {
      state.confirmations += 1;
      return send(201, { id: `confirmation-${state.confirmations}` });
    }
    if (path === "/notifications/order-cancellation") {
      state.cancellations.push({
        orderId: String(body.orderId),
        customerEmail: String(body.customerEmail),
        reason: String(body.reason),
      });
      return send(201, { id: `cancellation-${state.cancellations.length}` });
    }
    send(404, { error: "Unknown stub route" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    state,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startOrdersService(env: Record<string, string>): Promise<{ child: ChildProcess; baseUrl: string; output: () => string }> {
  const entry = fileURLToPath(new URL("./server.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`orders exited with ${child.exitCode}: ${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { child, baseUrl, output: () => output };
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`orders did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function stopOrdersService(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("serves cancellation over HTTP against the real database and HTTP clients", async () => {
  const stub = await startStub();
  const temp = temporaryDatabase();
  let child: ChildProcess | undefined;
  try {
    // a database written by the previous release (legacy status CHECK, no cancellation columns)
    const legacy = new DatabaseSync(temp.path);
    legacy.exec(LEGACY_SCHEMA);
    legacy.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-1", "legacy@example.com", "prod-a", 2, 3000, "CONFIRMED", "2025-12-31T00:00:00.000Z");
    legacy.close();

    const port = await freePort();
    const started = await startOrdersService({
      PORT: String(port),
      DATABASE_PATH: temp.path,
      INVENTORY_URL: stub.url,
      NOTIFICATIONS_URL: stub.url,
    });
    child = started.child;
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${started.baseUrl}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed = await response.json() as Record<string, any>;
      return { status: response.status, body: parsed };
    };
    const post = (path: string, body?: unknown) => request("POST", path, body);

    // the legacy row survived the startup migration and can now be cancelled
    const legacyDetail = await request("GET", "/orders/legacy-1");
    assert.equal(legacyDetail.status, 200);
    assert.equal(legacyDetail.body.status, "CONFIRMED");
    assert.equal(legacyDetail.body.quantity, 2);

    const legacyCancelled = await post("/orders/legacy-1/cancel", { reason: "Changed my mind" });
    assert.equal(legacyCancelled.status, 200);
    assert.equal(legacyCancelled.body.status, "CANCELLED");
    assert.ok(legacyCancelled.body.cancelledAt);
    assert.equal(stub.state.appliedRestoreKeys.filter((key) => key === "order-cancel:legacy-1").length, 1);
    assert.deepEqual(stub.state.cancellations, [
      { orderId: "legacy-1", customerEmail: "legacy@example.com", reason: "Changed my mind" },
    ]);

    // create, cancel, and repeat the cancellation
    const created = await post("/orders", { productId: "prod-a", quantity: 1, customerEmail: "buyer@example.com" });
    assert.equal(created.status, 201);
    const orderId = created.body.id;
    assert.ok(orderId);

    const cancelled = await post(`/orders/${orderId}/cancel`, { reason: "Changed my mind" });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "CANCELLED");
    assert.ok(cancelled.body.cancelledAt);
    assert.equal(cancelled.body.cancellationReason, "Changed my mind");
    assert.equal(stub.state.appliedRestoreKeys.filter((key) => key === `order-cancel:${orderId}`).length, 1);
    assert.equal(stub.state.cancellations.length, 2);
    assert.deepEqual(stub.state.cancellations[1], {
      orderId, customerEmail: "buyer@example.com", reason: "Changed my mind",
    });

    const repeated = await post(`/orders/${orderId}/cancel`, { reason: "Changed my mind" });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.status, "CANCELLED");
    assert.equal(stub.state.appliedRestoreKeys.filter((key) => key === `order-cancel:${orderId}`).length, 1);
    assert.equal(stub.state.cancellations.length, 2);
    assert.equal(stub.state.restoreKeys.filter((key) => key === `order-cancel:${orderId}`).length, 1);

    // invalid reason -> 400
    const blank = await post(`/orders/${orderId}/cancel`, { reason: "   " });
    assert.equal(blank.status, 400);
    assert.match(String(blank.body.error), /reason is required/);
    const tooLong = await post(`/orders/${orderId}/cancel`, { reason: "r".repeat(201) });
    assert.equal(tooLong.status, 400);

    // unknown order -> 404
    const missing = await post("/orders/does-not-exist/cancel", { reason: "Changed my mind" });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "Order not found");

    // shipped order -> 409
    const shippedOrder = await post("/orders", { productId: "prod-a", quantity: 1, customerEmail: "buyer@example.com" });
    assert.equal((await post(`/orders/${shippedOrder.body.id}/ship`)).status, 200);
    const conflict = await post(`/orders/${shippedOrder.body.id}/cancel`, { reason: "Changed my mind" });
    assert.equal(conflict.status, 409);
    assert.match(String(conflict.body.error), /after shipping/);
    assert.equal((await request("GET", `/orders/${shippedOrder.body.id}`)).body.status, "SHIPPED");

    // a failing restore stays durable -> 502 with the current order state, then completes on retry
    const pendingOrder = await post("/orders", { productId: "prod-a", quantity: 4, customerEmail: "buyer@example.com" });
    const pendingId = pendingOrder.body.id;
    stub.state.failNextRestoreStatus = 500;
    const failed = await post(`/orders/${pendingId}/cancel`, { reason: "Too late" });
    assert.equal(failed.status, 502);
    assert.match(String(failed.body.error), /completion is pending/);
    assert.equal(failed.body.order.status, "CANCELLED");
    assert.equal(failed.body.order.inventoryRestoreState, "PENDING");
    assert.equal((await request("GET", `/orders/${pendingId}`)).body.status, "CANCELLED");
    assert.equal(stub.state.cancellations.length, 2);

    const recovered = await post(`/orders/${pendingId}/cancel`, { reason: "Too late" });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.inventoryRestoreState, "DONE");
    assert.ok(recovered.body.cancellationNotifiedAt);
    assert.equal(stub.state.appliedRestoreKeys.filter((key) => key === `order-cancel:${pendingId}`).length, 1);
    assert.equal(stub.state.restoreKeys.filter((key) => key === `order-cancel:${pendingId}`).length, 2);
    assert.equal(stub.state.cancellations.length, 3);
    assert.deepEqual(
      stub.state.requests.filter((entry) => entry.path === "/inventory/restore").map((entry) => entry.body),
      [
        { productId: "prod-a", quantity: 2, idempotencyKey: "order-cancel:legacy-1" },
        { productId: "prod-a", quantity: 1, idempotencyKey: `order-cancel:${orderId}` },
        { productId: "prod-a", quantity: 4, idempotencyKey: `order-cancel:${pendingId}` },
        { productId: "prod-a", quantity: 4, idempotencyKey: `order-cancel:${pendingId}` },
      ],
    );
    assert.equal((await request("GET", "/nope")).status, 404);
    assert.equal((await request("GET", "/health")).body.ok, true);
  } finally {
    if (child) await stopOrdersService(child);
    await stub.close();
    temp.cleanup();
  }
});

test("startup reconciliation completes a cancellation left pending by a previous process", async () => {
  const stub = await startStub();
  const temp = temporaryDatabase();
  let child: ChildProcess | undefined;
  try {
    // a crash between the cancellation commit and its compensation leaves this durable state behind
    const seeded = new OrderDatabase(temp.path);
    seeded.create({
      id: "pending-1",
      customerEmail: "buyer@example.com",
      productId: "prod-a",
      quantity: 2,
      totalCents: 3000,
      status: "CANCELLED",
      createdAt: "2025-12-31T00:00:00.000Z",
      cancelledAt: "2025-12-31T00:00:01.000Z",
      cancellationReason: "Changed my mind",
      inventoryRestoreState: "PENDING",
      cancellationNotifiedAt: null,
    });
    assert.deepEqual(seeded.listPendingCancellations().map((order) => order.id), ["pending-1"]);

    const port = await freePort();
    const started = await startOrdersService({
      PORT: String(port),
      DATABASE_PATH: temp.path,
      INVENTORY_URL: stub.url,
      NOTIFICATIONS_URL: stub.url,
    });
    child = started.child;

    const deadline = Date.now() + 20_000;
    let order: Record<string, any> = {};
    for (;;) {
      const response = await fetch(`${started.baseUrl}/orders/pending-1`);
      order = await response.json() as Record<string, any>;
      if (order.inventoryRestoreState === "DONE" && order.cancellationNotifiedAt) break;
      if (Date.now() > deadline) throw new Error(`reconciliation did not complete: ${JSON.stringify(order)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.equal(order.status, "CANCELLED");
    assert.deepEqual(stub.state.appliedRestoreKeys, ["order-cancel:pending-1"]);
    assert.deepEqual(stub.state.cancellations, [
      { orderId: "pending-1", customerEmail: "buyer@example.com", reason: "Changed my mind" },
    ]);
  } finally {
    if (child) await stopOrdersService(child);
    await stub.close();
    temp.cleanup();
  }
});
