import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CANCELLATION_REASON,
  validateCancellationReason,
} from "../.test-dist/cancelReason.js";

const REQUIRED = "A cancellation reason is required";
const TOO_LONG = "Cancellation reason must be 200 characters or fewer";

test("exposes the 200 character limit", () => {
  assert.equal(MAX_CANCELLATION_REASON, 200);
});

test("rejects an empty reason", () => {
  assert.equal(validateCancellationReason(""), REQUIRED);
});

test("rejects a whitespace-only reason", () => {
  assert.equal(validateCancellationReason("   "), REQUIRED);
  assert.equal(validateCancellationReason("\t\n "), REQUIRED);
});

test("accepts a valid short reason", () => {
  assert.equal(validateCancellationReason("Changed my mind"), undefined);
});

test("accepts a reason of exactly 200 characters", () => {
  assert.equal(validateCancellationReason("a".repeat(200)), undefined);
});

test("rejects a reason of 201 characters", () => {
  assert.equal(validateCancellationReason("a".repeat(201)), TOO_LONG);
});

test("applies the length rule to the trimmed value", () => {
  assert.equal(validateCancellationReason(`   ${"a".repeat(200)}   `), undefined);
  assert.equal(validateCancellationReason(`   ${"a".repeat(201)}   `), TOO_LONG);
  assert.equal(validateCancellationReason(`   ${"a".repeat(199)}   `), undefined);
});
