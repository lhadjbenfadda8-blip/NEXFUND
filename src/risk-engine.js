/**
 * Deterministic evaluation engine. All money values are in account currency.
 * This module only evaluates supplied snapshots; it does not connect to MT5.
 */
export function evaluateChallenge(snapshot, rules) {
  const required = ["initialBalance", "equity", "dailyStartEquity", "highWatermark"];
  for (const key of required) {
    if (!Number.isFinite(Number(snapshot[key]))) throw new TypeError(`Invalid ${key}`);
  }
  const initial = Number(snapshot.initialBalance);
  const equity = Number(snapshot.equity);
  const dailyStart = Number(snapshot.dailyStartEquity);
  const highWater = Number(snapshot.highWatermark);
  if (initial <= 0 || dailyStart <= 0 || highWater <= 0) throw new RangeError("Balances must be positive.");

  const dailyLossPct = Math.max(0, (dailyStart - equity) / dailyStart * 100);
  const totalLossPct = Math.max(0, (initial - equity) / initial * 100);
  const profitPct = (equity - initial) / initial * 100;
  const events = [];
  let status = "active";
  let failureReason = null;

  if (dailyLossPct >= Number(rules.dailyDrawdownPct)) {
    status = "failed"; failureReason = "daily_drawdown";
    events.push({ type: "daily_drawdown", severity: "breach", value: dailyLossPct, threshold: Number(rules.dailyDrawdownPct) });
  } else if (totalLossPct >= Number(rules.maxDrawdownPct)) {
    status = "failed"; failureReason = "maximum_drawdown";
    events.push({ type: "maximum_drawdown", severity: "breach", value: totalLossPct, threshold: Number(rules.maxDrawdownPct) });
  } else if (profitPct >= Number(rules.profitTargetPct)) {
    status = "passed";
    events.push({ type: "profit_target", severity: "info", value: profitPct, threshold: Number(rules.profitTargetPct) });
  }
  return { status, failureReason, metrics: { dailyLossPct, totalLossPct, profitPct, highWatermark: Math.max(highWater, equity) }, events };
}
