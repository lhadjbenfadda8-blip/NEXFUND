// Reject replay of a confirmed TRC20 transfer that predates its payment intent.
export function isTransferAfterPaymentCreation(transfer, paymentCreatedAt) {
  const paymentCreatedAtMs = Date.parse(String(paymentCreatedAt || ""));
  const transferTimestampMs = Number(transfer?.block_timestamp);
  return Number.isFinite(paymentCreatedAtMs) &&
    Number.isFinite(transferTimestampMs) &&
    transferTimestampMs >= paymentCreatedAtMs;
}
