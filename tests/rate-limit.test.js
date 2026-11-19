import test from "node:test";
import assert from "node:assert/strict";
import { checkAuthRateLimit } from "../src/rate-limit.js";

function mockDb() {
  const records = new Map();
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async run() { if (sql.startsWith("DELETE")) { for (const [key,row] of records) if (row.windowStart < values[0]) records.delete(key); } return {success:true}; },
        async first() {
          if (!sql.includes("INSERT INTO auth_rate_limits")) throw new Error("Unexpected SQL");
          const [key, windowStart] = values;
          const prior = records.get(key);
          const attempts = prior && prior.windowStart === windowStart ? prior.attempts + 1 : 1;
          records.set(key,{windowStart,attempts});
          return {attempts,window_start:windowStart};
        }
      };
      return statement;
    }
  };
}

test("rate limiter blocks after configured limit in same window", async () => {
  const db=mockDb(), req=new Request("https://nexfund.test/api/auth/login",{headers:{"CF-Connecting-IP":"203.0.113.10"}});
  const options={limit:2,windowSeconds:900,nowMs:1700000000000};
  assert.equal((await checkAuthRateLimit(db,req,"login",options)).allowed,true);
  assert.equal((await checkAuthRateLimit(db,req,"login",options)).allowed,true);
  const third=await checkAuthRateLimit(db,req,"login",options);
  assert.equal(third.allowed,false);
  assert.equal(third.remaining,0);
  assert.ok(third.retryAfter>0);
});

test("rate limiter isolates IPs and routes and resets on new window", async () => {
  const db=mockDb(), base={limit:1,windowSeconds:900,nowMs:1700000000000};
  const reqA=new Request("https://nexfund.test/api/auth/login",{headers:{"CF-Connecting-IP":"203.0.113.10"}});
  const reqB=new Request("https://nexfund.test/api/auth/login",{headers:{"CF-Connecting-IP":"203.0.113.11"}});
  assert.equal((await checkAuthRateLimit(db,reqA,"login",base)).allowed,true);
  assert.equal((await checkAuthRateLimit(db,reqA,"register",base)).allowed,true);
  assert.equal((await checkAuthRateLimit(db,reqB,"login",base)).allowed,true);
  assert.equal((await checkAuthRateLimit(db,reqA,"login",{...base,nowMs:base.nowMs+900000})).allowed,true);
});
