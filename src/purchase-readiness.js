export function getPurchaseReadiness(env = {}) {
  let providerUrlValid = false;
  try {
    const endpoint = new URL(String(env.MT5_PROVIDER_API_URL || ""));
    providerUrlValid = endpoint.protocol === "https:";
  } catch {}
  let encryptionKeyValid = false;
  try { encryptionKeyValid = atob(String(env.CREDENTIALS_ENCRYPTION_KEY || "")).length === 32; } catch {}
  return {
    paymentsEnabled: env.PAYMENTS_ENABLED === "true",
    receivingAddressConfigured: Boolean(String(env.USDT_TRC20_ADDRESS || "").trim()),
    providerUrlValid,
    providerApiKeyConfigured: Boolean(env.MT5_PROVIDER_API_KEY),
    encryptionKeyValid,
    emailConfigured: Boolean(env.RESEND_API_KEY && env.MT5_EMAIL_FROM)
  };
}
export function isProvisioningConfigured(env = {}) {
  const r = getPurchaseReadiness(env);
  return r.providerUrlValid && r.encryptionKeyValid && r.providerApiKeyConfigured && r.emailConfigured;
}
export function isPurchaseEnabled(env = {}) {
  const r = getPurchaseReadiness(env);
  return r.paymentsEnabled && r.receivingAddressConfigured && isProvisioningConfigured(env);
}
