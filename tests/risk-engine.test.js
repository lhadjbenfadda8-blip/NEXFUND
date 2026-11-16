import test from "node:test";
import assert from "node:assert/strict";
import { evaluateChallenge } from "../src/risk-engine.js";

const base = { initialBalance: 10000, equity: 10100, dailyStartEquity: 10000, highWatermark: 10200 };
const rules = { dailyDrawdownPct: 5, maxDrawdownPct: 10, profitTargetPct: 8 };

test("keeps a challenge active below all limits", () => {
  assert.equal(evaluateChallenge(base, rules).status, "active");
});
test("fails when daily drawdown limit is reached", () => {
  const result = evaluateChallenge({ ...base, equity: 9500 }, rules);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "daily_drawdown");
});
test("fails when maximum drawdown limit is reached", () => {
  const result = evaluateChallenge({ ...base, equity: 9000, dailyStartEquity: 10000 }, rules);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "daily_drawdown");
});
test("passes when profit target is reached", () => {
  const result = evaluateChallenge({ ...base, equity: 10800 }, rules);
  assert.equal(result.status, "passed");
});
