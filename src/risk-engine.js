/**
 * Pure challenge risk evaluator.
 * Inputs must come from a trusted trading-account snapshot; this module does not connect to MT5.
 * Daily loss is measured against dailyStartEquity. Overall loss is static against initialBalance.
 */
export function evaluateChallenge(snapshot, rules) {
  const requiredSnapshot = ["initialBalance", "equity", "dailyStartEquity", "highWatermark"];
  for (const key of requiredSnapshot) {
    if (!Number.isFinite(Number(snapshot?.[key]))) throw new TypeError(`Invalid ${key}`);
  }
  const initial = Number(snapshot.initialBalance);
  const equity = Number(snapshot.equity);
  const dailyStart = Number(snapshot.dailyStartEquity);
  const priorHighWater = Number(snapshot.highWatermark);
  if (initial <= 0 || dailyStart <= 0 || priorHighWater <= 0) throw new RangeError("Balances must be positive.");

  const requiredRules = ["dailyDrawdownPct", "maxDrawdownPct", "profitTargetPct"];
  for (const key of requiredRules) {
    if (!Number.isFinite(Number(rules?.[key])) || Number(rules[key]) <= 0 || Number(rules[key]) > 100) {
      throw new RangeError(`Invalid rule: ${key}`);
    }
  }
  const minTradingDays = Math.max(0, Math.floor(Number(rules.minTradingDays ?? 0)));
  const tradingDays = Math.max(0, Math.floor(Number(snapshot.tradingDays ?? 0)));
  if (!Number.isFinite(minTradingDays) || !Number.isFinite(tradingDays)) throw new RangeError("Invalid trading days.");

  const dailyLossPct = Math.max(0, (dailyStart - equity) / dailyStart * 100);
  const totalLossPct = Math.max(0, (initial - equity) / initial * 100);
  const profitPct = (equity - initial) / initial * 100;
  const highWatermark = Math.max(priorHighWater, equity);
  const trailingDrawdownPct = Math.max(0, (highWatermark - equity) / highWatermark * 100);
  const trailingLimit = rules.trailingDrawdownPct == null ? null : Number(rules.trailingDrawdownPct);
  if (trailingLimit !== null && (!Number.isFinite(trailingLimit) || trailingLimit <= 0 || trailingLimit > 100)) throw new RangeError("Invalid rule: trailingDrawdownPct");
  const events = [];
  let status = "active";
  let failureReason = null;

  if (dailyLossPct >= Number(rules.dailyDrawdownPct)) {
    status = "failed";
    failureReason = "daily_drawdown";
    events.push({ type: "daily_drawdown", severity: "breach", value: dailyLossPct, threshold: Number(rules.dailyDrawdownPct) });
  } else if (totalLossPct >= Number(rules.maxDrawdownPct)) {
    status = "failed";
    failureReason = "maximum_drawdown";
    events.push({ type: "maximum_drawdown", severity: "breach", value: totalLossPct, threshold: Number(rules.maxDrawdownPct) });
  } else if (trailingLimit !== null && trailingDrawdownPct >= trailingLimit) {
    status = "failed";
    failureReason = "trailing_drawdown";
    events.push({ type: "trailing_drawdown", severity: "breach", value: trailingDrawdownPct, threshold: trailingLimit });
  } else if (profitPct >= Number(rules.profitTargetPct) && tradingDays >= minTradingDays) {
    status = "passed";
    events.push({ type: "profit_target", severity: "info", value: profitPct, threshold: Number(rules.profitTargetPct) });
  } else if (profitPct >= Number(rules.profitTargetPct) && tradingDays < minTradingDays) {
    events.push({ type: "profit_target_waiting_days", severity: "info", value: tradingDays, threshold: minTradingDays });
  }

  return {
    status,
    failureReason,
    metrics: { dailyLossPct, totalLossPct, trailingDrawdownPct, profitPct, highWatermark, tradingDays, minTradingDays, remainingTradingDays: Math.max(0, minTradingDays - tradingDays) },
    events
  };
}
