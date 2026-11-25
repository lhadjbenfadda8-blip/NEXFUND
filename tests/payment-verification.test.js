import test from "node:test";
import assert from "node:assert/strict";
import { isTransferAfterPaymentCreation } from "../src/payment-verification.js";

const paymentCreatedAt = "2026-11-25T10:00:00.000Z";
const sqlitePaymentCreatedAt = "2026-11-25 10:00:00";

test("accepts a confirmed transfer timestamped at or after payment creation", () => {
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: Date.parse(paymentCreatedAt) }, paymentCreatedAt), true);
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: Date.parse(paymentCreatedAt) + 1000 }, paymentCreatedAt), true);
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: Date.parse(paymentCreatedAt) }, sqlitePaymentCreatedAt), true);
});

test("rejects a transfer that predates the payment intent", () => {
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: Date.parse(paymentCreatedAt) - 1 }, paymentCreatedAt), false);
});

test("rejects missing or invalid timestamps", () => {
  assert.equal(isTransferAfterPaymentCreation({}, paymentCreatedAt), false);
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: "not-a-time" }, paymentCreatedAt), false);
  assert.equal(isTransferAfterPaymentCreation({ block_timestamp: Date.now() }, "invalid-date"), false);
});
