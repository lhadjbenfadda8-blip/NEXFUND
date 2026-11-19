import test from "node:test";
import assert from "node:assert/strict";
import { isProvisioningConfigured, isPurchaseEnabled } from "../src/purchase-readiness.js";

const readyEnv={
  PAYMENTS_ENABLED:"true",
  USDT_TRC20_ADDRESS:"TReadinessFixtureAddress",
  MT5_PROVIDER_API_URL:"https://provider.example/api/accounts",
  MT5_PROVIDER_API_KEY:"provider-key",
  RESEND_API_KEY:"resend-key",
  MT5_EMAIL_FROM:"NEXFUND <accounts@example.com>",
  CREDENTIALS_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
};

test("purchases require payment flag and all HTTPS provider/email/key settings",()=>{
  assert.equal(isProvisioningConfigured(readyEnv),true);
  assert.equal(isPurchaseEnabled(readyEnv),true);
  assert.equal(isPurchaseEnabled({...readyEnv,PAYMENTS_ENABLED:"false"}),false);
  assert.equal(isPurchaseEnabled({...readyEnv,MT5_PROVIDER_API_KEY:""}),false);
  assert.equal(isPurchaseEnabled({...readyEnv,MT5_PROVIDER_API_URL:"http://provider.example"}),false);
  assert.equal(isPurchaseEnabled({...readyEnv,RESEND_API_KEY:""}),false);
  assert.equal(isPurchaseEnabled({...readyEnv,CREDENTIALS_ENCRYPTION_KEY:"bad"}),false);
});

test("purchase readiness requires a configured receiving wallet",()=>{
  assert.equal(isPurchaseEnabled({...readyEnv,USDT_TRC20_ADDRESS:""}),false);
});

test("encryption key validation works without Node-specific Buffer or atob globals",()=>{
  assert.equal(isProvisioningConfigured(readyEnv),true);
  assert.equal(isProvisioningConfigured({...readyEnv,CREDENTIALS_ENCRYPTION_KEY:"bad"}),false);
  assert.equal(isProvisioningConfigured({...readyEnv,CREDENTIALS_ENCRYPTION_KEY:"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}),false);
});
