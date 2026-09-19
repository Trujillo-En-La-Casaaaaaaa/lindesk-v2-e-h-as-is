import assert from "node:assert/strict";
import test from "node:test";
import { OrderService, type InventoryPort, type NotificationPort, type Order, type OrderRepository } from "./orders.js";

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
  remove(id: string) { this.items.delete(id); }
}

function fixture(decrementFails = false) {
  const calls: string[] = [];
  const inventory: InventoryPort = {
    async validate() { calls.push("validate"); return { product: { priceCents: 1500 } }; },
    async decrement() { calls.push("decrement"); if (decrementFails) throw new Error("race"); },
  };
  const notifications: NotificationPort = {
    async orderConfirmation() { calls.push("notify"); },
  };
  const repository = new MemoryOrders();
  return {
    service: new OrderService(repository, inventory, notifications, () => "order-1", () => "2026-01-01T00:00:00.000Z"),
    repository, calls,
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
