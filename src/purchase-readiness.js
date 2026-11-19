function isBase64Encoded32ByteKey(value) {
  const encoded = String(value || "").trim();
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  return decodedLength === 32;
}

export function getPurchaseReadiness(env = {}) {
  let providerUrlValid = false;
  try {
    const endpoint = new URL(String(env.MT5_PROVIDER_API_URL || ""));
    providerUrlValid = endpoint.protocol === "https:";
  } catch {}
  const encryptionKeyValid = isBase64Encoded32ByteKey(env.CREDENTIALS_ENCRYPTION_KEY);
  return {
    paymentsEnabled: env.PAYMENTS_ENABLED === "true",
    receivingAddressConfigured: /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(env.USDT_TRC20_ADDRESS || "").trim()),
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
