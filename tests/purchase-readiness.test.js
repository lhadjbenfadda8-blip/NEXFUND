import test from "node:test";
import assert from "node:assert/strict";
import { isProvisioningConfigured, isPurchaseEnabled } from "../src/purchase-readiness.js";

const readyEnv={
  PAYMENTS_ENABLED:"true",
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
