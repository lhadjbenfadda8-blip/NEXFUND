export function isProvisioningConfigured(env = {}) {
  try {
    const endpoint = new URL(String(env.MT5_PROVIDER_API_URL || ""));
    const keyBytes=atob(String(env.CREDENTIALS_ENCRYPTION_KEY||""));
    return endpoint.protocol === "https:" && keyBytes.length === 32
      && Boolean(env.MT5_PROVIDER_API_KEY && env.RESEND_API_KEY && env.MT5_EMAIL_FROM);
  } catch {
    return false;
  }
}

export function isPurchaseEnabled(env = {}) {
  return env.PAYMENTS_ENABLED === "true" && isProvisioningConfigured(env);
}
