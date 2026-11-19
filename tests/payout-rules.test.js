import test from "node:test";
import assert from "node:assert/strict";
import { remainingPayoutLimit, isAllowedPayoutTransition } from "../src/payout-rules.js";

test("remaining payout allowance subtracts pending, approved, and paid amounts",()=>{
  assert.equal(remainingPayoutLimit(1000,200),600);
  assert.equal(remainingPayoutLimit(1000,800),0);
  assert.equal(remainingPayoutLimit(500,0),400);
});

test("invalid values cannot produce payout allowance",()=>{
  assert.equal(remainingPayoutLimit(-100,0),0);
  assert.equal(remainingPayoutLimit(100,-1),0);
  assert.equal(remainingPayoutLimit(100,0,1.5),0);
});

test("payout lifecycle only allows pending review then approved payment",()=>{
  assert.equal(isAllowedPayoutTransition("pending","approved"),true);
  assert.equal(isAllowedPayoutTransition("pending","rejected"),true);
  assert.equal(isAllowedPayoutTransition("approved","paid"),true);
  assert.equal(isAllowedPayoutTransition("pending","paid"),false);
  assert.equal(isAllowedPayoutTransition("approved","rejected"),false);
  assert.equal(isAllowedPayoutTransition("paid","approved"),false);
  assert.equal(isAllowedPayoutTransition("rejected","approved"),false);
});
