function parseRules(value) {
  if (typeof value !== "string" || !value.trim()) return {};
  try { const parsed=JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

export function snapshotChallengeRules(program) {
  const raw=parseRules(program.rules_json);
  return {
    profit_target_pct:Number(program.profit_target_pct),
    daily_drawdown_pct:Number(program.daily_drawdown_pct),
    max_drawdown_pct:Number(program.max_drawdown_pct),
    min_trading_days:Math.max(0,Math.floor(Number(program.min_trading_days||0))),
    max_trading_days:program.max_trading_days==null?null:Math.floor(Number(program.max_trading_days)),
    rules_json:JSON.stringify(raw)
  };
}

export function resolveChallengeRules(challenge, program = {}) {
  const snapshot=parseRules(challenge.rules_snapshot_json);
  const source=snapshot && Object.keys(snapshot).length ? snapshot : program;
  const nested=parseRules(source.rules_json);
  return {
    profitTargetPct:Number(source.profit_target_pct ?? program.profit_target_pct),
    dailyDrawdownPct:Number(source.daily_drawdown_pct ?? program.daily_drawdown_pct),
    maxDrawdownPct:Number(source.max_drawdown_pct ?? program.max_drawdown_pct),
    minTradingDays:Math.max(0,Math.floor(Number(source.min_trading_days ?? program.min_trading_days ?? 0))),
    maxTradingDays:Object.hasOwn(source,"max_trading_days") ? (source.max_trading_days==null?null:Number(source.max_trading_days)) : (program.max_trading_days==null?null:Number(program.max_trading_days)),
    trailingDrawdownPct:nested.trailing_drawdown_pct==null?null:Number(nested.trailing_drawdown_pct)
  };
}
