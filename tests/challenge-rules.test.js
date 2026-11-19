import test from "node:test";
import assert from "node:assert/strict";
import { snapshotChallengeRules, resolveChallengeRules } from "../src/challenge-rules.js";

test("snapshot captures evaluation terms at challenge purchase time",()=>{
  const program={profit_target_pct:8,daily_drawdown_pct:5,max_drawdown_pct:10,min_trading_days:5,max_trading_days:null,rules_json:'{"trailing_drawdown_pct":6,"phase":"one_step"}'};
  const snapshot=snapshotChallengeRules(program);
  assert.equal(snapshot.profit_target_pct,8);
  assert.equal(snapshot.daily_drawdown_pct,5);
  assert.equal(snapshot.max_drawdown_pct,10);
  assert.equal(snapshot.min_trading_days,5);
  assert.equal(snapshot.max_trading_days,null);
  assert.equal(JSON.parse(snapshot.rules_json).trailing_drawdown_pct,6);
});

test("challenge uses stored terms rather than subsequently changed program terms",()=>{
  const challenge={rules_snapshot_json:JSON.stringify({profit_target_pct:8,daily_drawdown_pct:5,max_drawdown_pct:10,min_trading_days:5,max_trading_days:null,rules_json:'{"trailing_drawdown_pct":6}'})};
  const changedProgram={profit_target_pct:12,daily_drawdown_pct:3,max_drawdown_pct:7,min_trading_days:10,max_trading_days:20,rules_json:'{"trailing_drawdown_pct":4}'};
  assert.deepEqual(resolveChallengeRules(challenge,changedProgram),{profitTargetPct:8,dailyDrawdownPct:5,maxDrawdownPct:10,minTradingDays:5,maxTradingDays:null,trailingDrawdownPct:6});
});

test("legacy challenges without snapshots fall back to current program rules",()=>{
  assert.deepEqual(resolveChallengeRules({}, {profit_target_pct:8,daily_drawdown_pct:5,max_drawdown_pct:10,min_trading_days:2,max_trading_days:10,rules_json:'{"trailing_drawdown_pct":4}'}),{profitTargetPct:8,dailyDrawdownPct:5,maxDrawdownPct:10,minTradingDays:2,maxTradingDays:10,trailingDrawdownPct:4});
});
