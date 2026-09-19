import assert from "node:assert/strict";
import test from "node:test";

const baseUrl = process.env.SHOPFLOW_BASE_URL ?? "http://127.0.0.1:3000";

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

test("public workflow crosses service APIs and records confirmation", async () => {
  const health = await request("GET", "/api/health");
  assert.equal(health.status, 200);

  const before = await request("GET", "/api/products/prod-a");
  assert.equal(before.status, 200);

  const created = await request("POST", "/api/orders", {
    productId: "prod-a",
    quantity: 1,
    customerEmail: "integration@example.com",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "CONFIRMED");

  const after = await request("GET", "/api/products/prod-a");
  assert.equal(after.json.stock, before.json.stock - 1);

  const shipped = await request("POST", `/api/orders/${created.json.id}/ship`);
  assert.equal(shipped.status, 200);
  assert.equal(shipped.json.status, "SHIPPED");

  const notifications = await request("GET", "/api/notifications");
  assert.equal(notifications.status, 200);
  assert.ok(notifications.json.some(
    message => message.type === "ORDER_CONFIRMATION" && message.orderId === created.json.id
  ));

  const cancellation = await request("POST", `/api/orders/${created.json.id}/cancel`, {
    reason: "not supported",
  });
  assert.equal(cancellation.status, 404);
});
