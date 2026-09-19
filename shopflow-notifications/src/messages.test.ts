import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderCancellation, buildOrderConfirmation } from "./messages.js";

const status = (error: unknown): number | undefined => (error as { status?: number }).status;

test("buildOrderCancellation builds an ORDER_CANCELLATION message with a stable key", () => {
  const message = buildOrderCancellation({
    orderId: "o1",
    customerEmail: "buyer@example.com",
    reason: "Changed my mind",
  });
  assert.deepEqual(message, {
    type: "ORDER_CANCELLATION",
    orderId: "o1",
    to: "buyer@example.com",
    idempotencyKey: "order-cancellation:o1",
    payload: { orderId: "o1", reason: "Changed my mind" },
  });
});

test("buildOrderCancellation rejects a missing orderId", () => {
  assert.throws(
    () => buildOrderCancellation({ customerEmail: "buyer@example.com", reason: "x" }),
    (error: unknown) => status(error) === 400 && (error as Error).message === "Invalid notification",
  );
});

test("buildOrderCancellation rejects a blank orderId", () => {
  assert.throws(
    () => buildOrderCancellation({ orderId: "   ", customerEmail: "buyer@example.com" }),
    (error: unknown) => status(error) === 400,
  );
});

test("buildOrderCancellation rejects a customerEmail without @", () => {
  assert.throws(
    () => buildOrderCancellation({ orderId: "o1", customerEmail: "buyer.example.com" }),
    (error: unknown) => status(error) === 400 && (error as Error).message === "Invalid notification",
  );
});

test("buildOrderCancellation forwards an empty reason", () => {
  const message = buildOrderCancellation({ orderId: "o1", customerEmail: "buyer@example.com", reason: "" });
  assert.equal(message.payload.reason, "");
  assert.equal(message.idempotencyKey, "order-cancellation:o1");
});

test("buildOrderCancellation defaults a missing reason to an empty string", () => {
  const message = buildOrderCancellation({ orderId: "o1", customerEmail: "buyer@example.com" });
  assert.equal(message.payload.reason, "");
});

test("buildOrderConfirmation builds an ORDER_CONFIRMATION message with a stable key", () => {
  const message = buildOrderConfirmation({ orderId: "o1", customerEmail: "buyer@example.com" });
  assert.deepEqual(message, {
    type: "ORDER_CONFIRMATION",
    orderId: "o1",
    to: "buyer@example.com",
    idempotencyKey: "order-confirmation:o1",
    payload: { orderId: "o1" },
  });
});

test("buildOrderConfirmation rejects invalid input", () => {
  assert.throws(
    () => buildOrderConfirmation({ customerEmail: "buyer@example.com" }),
    (error: unknown) => status(error) === 400 && (error as Error).message === "Invalid notification",
  );
  assert.throws(
    () => buildOrderConfirmation({ orderId: "o1", customerEmail: "buyer.example.com" }),
    (error: unknown) => status(error) === 400,
  );
});
