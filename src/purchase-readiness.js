export function isProvisioningConfigured(env = {}) {
  try {
    const endpoint = new URL(String(env.MT5_PROVIDER_API_URL || ""));
    return endpoint.protocol === "https:"
      && Boolean(env.MT5_PROVIDER_API_KEY && env.RESEND_API_KEY && env.MT5_EMAIL_FROM && env.CREDENTIALS_ENCRYPTION_KEY);
  } catch {
    return false;
  }
}

export function isPurchaseEnabled(env = {}) {
  return env.PAYMENTS_ENABLED === "true" && isProvisioningConfigured(env);
}
