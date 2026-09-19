import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/**
 * ShopFlow cross-repository black-box acceptance test.
 *
 * It drives the running stack exclusively through the public gateway API
 * (`http://127.0.0.1:3000`) plus the deterministic provider emulator on
 * `http://127.0.0.1:3004` for the direct deduplication case. `docker compose`
 * is used only by the optional inventory-outage recovery case.
 *
 * Requirement-to-test traceability (see handoff Acceptance Criteria):
 *   rows 1, 2, 3, 7 -> "cancels a fresh order ..." / "repeated cancellation ..."
 *   rows 4, 5       -> "validates the cancellation reason ..."
 *   row 6           -> "baseline: health, stock read, order create, ship ..."
 *   row 8           -> "fault injection: cancellation recovers after ..." (gated)
 *   row 9           -> "provider emulator deduplicates POST /messages ..."
 *   row 10          -> "baseline: health, stock read, order create, ship ..."
 */

const baseUrl = process.env.SHOPFLOW_BASE_URL ?? "http://127.0.0.1:3000";
const providerBaseUrl = process.env.SHOPFLOW_PROVIDER_URL ?? "http://127.0.0.1:3004";
const faultInjectionEnabled = process.env.SHOPFLOW_FAULT_INJECTION === "1";
const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const productId = "prod-a";

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  return { status: response.status, json };
}

function compose(...args) {
  return execFileSync("docker", ["compose", ...args], { cwd: repoRoot, encoding: "utf8" });
}

async function waitForOk(url, { attempts = 60, delayMs = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // keep polling until the dependency is reachable again
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function stockOf(id) {
  const response = await request("GET", `/api/products/${id}`);
  assert.equal(response.status, 200, `expected to read product ${id}`);
  return response.json.stock;
}

function startEmulator(logPath) {
  return spawn(process.execPath, ["provider.js"], {
    cwd: repoRoot,
    env: { ...process.env, MESSAGE_LOG_PATH: logPath },
    stdio: "ignore",
  });
}

function stopEmulator(emulator) {
  return new Promise(resolve => {
    if (emulator.exitCode !== null || emulator.signalCode !== null) return resolve();
    emulator.once("exit", () => resolve());
    emulator.kill();
  });
}

async function createOrder(overrides = {}) {
  const created = await request("POST", "/api/orders", {
    productId,
    quantity: 1,
    customerEmail: "integration@example.com",
    ...overrides,
  });
  assert.equal(created.status, 201, `order creation failed: ${JSON.stringify(created.json)}`);
  assert.equal(created.json.status, "CONFIRMED");
  return created.json;
}

async function notifications() {
  const response = await request("GET", "/api/notifications");
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.json), "notifications must be an array");
  return response.json;
}

function cancellationMessages(messages, orderId) {
  return messages.filter(message =>
    message.type === "ORDER_CANCELLATION" &&
    (message.orderId === orderId || message.payload?.orderId === orderId));
}

test("baseline: health, stock read, order create, ship and confirmation still work", async () => {
  const health = await request("GET", "/api/health");
  assert.equal(health.status, 200);

  const before = await request("GET", `/api/products/${productId}`);
  assert.equal(before.status, 200);

  const created = await request("POST", "/api/orders", {
    productId,
    quantity: 1,
    customerEmail: "integration@example.com",
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.status, "CONFIRMED");

  const after = await request("GET", `/api/products/${productId}`);
  assert.equal(after.json.stock, before.json.stock - 1, "creating an order must decrement stock by 1");

  const shipped = await request("POST", `/api/orders/${created.json.id}/ship`);
  assert.equal(shipped.status, 200);
  assert.equal(shipped.json.status, "SHIPPED");

  const recorded = await notifications();
  assert.ok(
    recorded.some(message =>
      message.type === "ORDER_CONFIRMATION" && message.orderId === created.json.id),
    "an ORDER_CONFIRMATION message must be recorded for the shipped order",
  );

  // Row 6: cancellation is now supported, but this order has already been shipped.
  const cancellation = await request("POST", `/api/orders/${created.json.id}/cancel`, {
    reason: "too late",
  });
  assert.equal(cancellation.status, 409, "cancelling a shipped order must be rejected with 409");

  const detail = await request("GET", `/api/orders/${created.json.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, "SHIPPED", "a rejected cancellation must leave the order SHIPPED");
  assert.equal(detail.json.cancelledAt, null);
  assert.equal(detail.json.cancellationReason, null);

  assert.equal(await stockOf(productId), after.json.stock, "a rejected cancellation must not change stock");

  const afterCancel = await notifications();
  assert.equal(
    cancellationMessages(afterCancel, created.json.id).length,
    0,
    "a rejected cancellation must not record a cancellation message",
  );
});

test("cancels a fresh order, restores inventory exactly once and notifies once", async () => {
  const stockBefore = await stockOf(productId);
  const order = await createOrder();
  assert.equal(await stockOf(productId), stockBefore - 1, "creating an order must decrement stock by 1");

  const cancelled = await request("POST", `/api/orders/${order.id}/cancel`, {
    reason: "Changed my mind",
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, "CANCELLED");
  assert.equal(cancelled.json.cancellationReason, "Changed my mind");
  assert.equal(typeof cancelled.json.cancelledAt, "string");
  assert.ok(cancelled.json.cancelledAt.length > 0, "cancelledAt must be a non-empty string");
  assert.ok(
    !Number.isNaN(Date.parse(cancelled.json.cancelledAt)),
    "cancelledAt must be an ISO timestamp",
  );

  const detail = await request("GET", `/api/orders/${order.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.status, "CANCELLED");
  assert.equal(detail.json.cancelledAt, cancelled.json.cancelledAt);
  assert.equal(detail.json.cancellationReason, "Changed my mind");

  assert.equal(await stockOf(productId), stockBefore, "inventory must be restored exactly once");

  const recorded = await notifications();
  assert.equal(
    cancellationMessages(recorded, order.id).length,
    1,
    "exactly one ORDER_CANCELLATION message must be recorded for the cancelled order",
  );
});

test("validates the cancellation reason: blank and >200 rejected, 200 accepted", async () => {
  const order = await createOrder();
  const stockAfterCreate = await stockOf(productId);

  const blank = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "" });
  assert.equal(blank.status, 400);

  const total = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "x".repeat(201) });
  assert.equal(total.status, 400);

  const rejectedOrder = await request("GET", `/api/orders/${order.id}`);
  assert.equal(rejectedOrder.status, 200);
  assert.equal(rejectedOrder.json.status, "CONFIRMED", "a rejected cancellation must leave the order CONFIRMED");
  assert.equal(await stockOf(productId), stockAfterCreate, "a rejected cancellation must not change stock");
  assert.equal(
    cancellationMessages(await notifications(), order.id).length,
    0,
    "a rejected cancellation must not record a cancellation message",
  );

  const fresh = await createOrder();
  const accepted = await request("POST", `/api/orders/${fresh.id}/cancel`, { reason: "y".repeat(200) });
  assert.equal(accepted.status, 200, "a 200-character reason must be accepted");
  assert.equal(accepted.json.status, "CANCELLED");
  assert.equal(accepted.json.cancellationReason, "y".repeat(200));
});

test("repeated cancellation converges to one restoration and one notification", async () => {
  const stockBefore = await stockOf(productId);
  const order = await createOrder();

  const first = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "first request" });
  assert.equal(first.status, 200);
  assert.equal(first.json.status, "CANCELLED");
  assert.equal(await stockOf(productId), stockBefore, "stock must be restored after the first cancellation");

  const second = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "second request" });
  assert.equal(second.status, 200, "a repeated cancellation must succeed idempotently");
  assert.equal(second.json.status, "CANCELLED");

  assert.equal(
    await stockOf(productId),
    stockBefore,
    "a repeated cancellation must not restore inventory twice",
  );

  const recorded = await notifications();
  assert.equal(
    cancellationMessages(recorded, order.id).length,
    1,
    "a repeated cancellation must create exactly one cancellation message",
  );
});

test("provider emulator deduplicates POST /messages by idempotencyKey", async () => {
  const logDir = mkdtempSync(join(tmpdir(), "shopflow-provider-"));
  const logPath = join(logDir, "messages.jsonl");
  let emulator = startEmulator(logPath);

  const post = (body) => fetch(`${providerBaseUrl}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const list = async () => (await fetch(`${providerBaseUrl}/messages`)).json();
  const countFor = async (keyToCount) =>
    (await list()).filter(message => message.idempotencyKey === keyToCount).length;

  try {
    await waitForOk(`${providerBaseUrl}/health`);

    const key = `dedup-${randomUUID()}`;
    const payload = {
      type: "ORDER_CANCELLATION",
      orderId: "order-dedup",
      to: "buyer@example.com",
      idempotencyKey: key,
      payload: { orderId: "order-dedup", reason: "dedup" },
    };

    const first = await post(payload);
    assert.equal(first.status, 201, "the first write must create a new message");
    const firstMessage = await first.json();

    const second = await post(payload);
    assert.ok(second.status >= 200 && second.status < 300, "the duplicate write must be a 2xx");
    const secondMessage = await second.json();
    assert.equal(secondMessage.id, firstMessage.id, "the duplicate must return the stored message id");
    assert.equal(await countFor(key), 1, "exactly one message must be stored per idempotency key");

    const distinct = await post({ ...payload, idempotencyKey: `dedup-${randomUUID()}` });
    assert.equal(distinct.status, 201, "a distinct idempotency key must still create a message");
    assert.equal((await list()).length, 2, "a distinct idempotency key must add a second stored message");

    // Restart the emulator against the same log to prove the idempotency index
    // is rebuilt from the persisted log, not just kept in process memory.
    await stopEmulator(emulator);
    emulator = startEmulator(logPath);
    await waitForOk(`${providerBaseUrl}/health`);

    const afterRestart = await post(payload);
    assert.ok(afterRestart.status >= 200 && afterRestart.status < 300, "the persisted key must dedup after a restart");
    const afterRestartMessage = await afterRestart.json();
    assert.equal(afterRestartMessage.id, firstMessage.id, "the persisted message must be returned after a restart");
    assert.equal(await countFor(key), 1, "the persisted log must hold one message per idempotency key");
    assert.equal((await list()).length, 2, "the duplicate after a restart must not append a new message");
  } finally {
    await stopEmulator(emulator);
    rmSync(logDir, { recursive: true, force: true });
  }
});

test(
  "fault injection: cancellation recovers after an inventory outage",
  {
    skip: faultInjectionEnabled
      ? false
      : "SHOPFLOW_FAULT_INJECTION is not set; skipping the inventory-outage recovery case (run with SHOPFLOW_FAULT_INJECTION=1)",
  },
  async () => {
    const stockBefore = await stockOf(productId);
    const order = await createOrder();

    compose("stop", "inventory");
    try {
      const failed = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "outage" });
      assert.equal(failed.status, 502, `expected 502 while inventory is stopped, got ${failed.status}`);

      const detail = await request("GET", `/api/orders/${order.id}`);
      assert.equal(detail.status, 200);
      assert.equal(
        detail.json.status,
        "CANCELLED",
        "the order must be durably CANCELLED even though compensation is still pending",
      );
    } finally {
      compose("start", "inventory");
    }

    await waitForOk(`${baseUrl}/api/products/${productId}`);

    const retried = await request("POST", `/api/orders/${order.id}/cancel`, { reason: "outage" });
    assert.equal(retried.status, 200, `the retry after recovery must succeed, got ${retried.status}`);
    assert.equal(retried.json.status, "CANCELLED");

    assert.equal(
      await stockOf(productId),
      stockBefore,
      "inventory must be restored exactly once after recovery, not twice",
    );
  },
);
