import test from "node:test";
import assert from "node:assert/strict";
import { evaluateChallenge } from "../src/risk-engine.js";

const base = { initialBalance: 10000, equity: 10100, dailyStartEquity: 10000, highWatermark: 10200, tradingDays: 5 };
const rules = { dailyDrawdownPct: 5, maxDrawdownPct: 10, profitTargetPct: 8, minTradingDays: 5 };

test("keeps a challenge active below all limits", () => {
  assert.equal(evaluateChallenge(base, rules).status, "active");
});
test("fails at daily loss threshold", () => {
  const result = evaluateChallenge({ ...base, equity: 9500 }, rules);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "daily_drawdown");
});
test("fails at static maximum loss threshold when daily limit is not breached", () => {
  const result = evaluateChallenge({ ...base, equity: 9000, dailyStartEquity: 9400 }, rules);
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "maximum_drawdown");
});
test("passes at profit target when minimum days are met", () => {
  const result = evaluateChallenge({ ...base, equity: 10800, tradingDays: 5 }, rules);
  assert.equal(result.status, "passed");
});
test("target is not passed until minimum trading days are met", () => {
  const result = evaluateChallenge({ ...base, equity: 10800, tradingDays: 3 }, rules);
  assert.equal(result.status, "active");
  assert.equal(result.metrics.remainingTradingDays, 2);
  assert.equal(result.events[0].type, "profit_target_waiting_days");
});
test("high watermark advances and never decreases", () => {
  assert.equal(evaluateChallenge({ ...base, equity: 10500 }, rules).metrics.highWatermark, 10500);
  assert.equal(evaluateChallenge({ ...base, equity: 9800 }, rules).metrics.highWatermark, 10200);
});
test("rejects invalid balances and invalid risk rules", () => {
  assert.throws(() => evaluateChallenge({ ...base, initialBalance: 0 }, rules), RangeError);
  assert.throws(() => evaluateChallenge(base, { ...rules, maxDrawdownPct: 0 }), RangeError);
});

test("fails optional trailing drawdown rule against peak equity", () => {
  const result = evaluateChallenge({ ...base, equity: 9700, highWatermark: 10300, dailyStartEquity: 10000 }, { ...rules, trailingDrawdownPct: 5 });
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "trailing_drawdown");
  assert.ok(result.metrics.trailingDrawdownPct > 5);
});
test("reports trailing drawdown but does not apply it unless configured", () => {
  const result = evaluateChallenge({ ...base, equity: 9700, highWatermark: 10300 }, rules);
  assert.equal(result.status, "active");
  assert.ok(result.metrics.trailingDrawdownPct > 5);
});
test("rejects invalid optional trailing drawdown rule", () => {
  assert.throws(() => evaluateChallenge(base, { ...rules, trailingDrawdownPct: 0 }), RangeError);
});

test("fails when maximum trading-day limit is exceeded", () => {
  const result = evaluateChallenge({ ...base, tradingDays: 11 }, { ...rules, maxTradingDays: 10 });
  assert.equal(result.status, "failed");
  assert.equal(result.failureReason, "maximum_trading_days");
  assert.equal(result.events[0].threshold, 10);
});
test("allows trading on the maximum day and rejects invalid max-day rule", () => {
  assert.equal(evaluateChallenge({ ...base, tradingDays: 10 }, { ...rules, maxTradingDays: 10 }).status, "active");
  assert.throws(() => evaluateChallenge(base, { ...rules, maxTradingDays: 4 }), RangeError);
});
