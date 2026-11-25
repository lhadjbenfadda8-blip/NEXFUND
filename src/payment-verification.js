// SQLite datetime('now') values have no timezone suffix; interpret them as UTC.
function parseUtcTimestamp(value) {
  const raw = String(value || "").trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? raw.replace(" ", "T") + "Z"
    : raw;
  return Date.parse(normalized);
}

// Reject replay of a confirmed TRC20 transfer that predates its payment intent.
export function isTransferAfterPaymentCreation(transfer, paymentCreatedAt) {
  const paymentCreatedAtMs = parseUtcTimestamp(paymentCreatedAt);
  const transferTimestampMs = Number(transfer?.block_timestamp);
  return Number.isFinite(paymentCreatedAtMs) &&
    Number.isFinite(transferTimestampMs) &&
    transferTimestampMs >= paymentCreatedAtMs;
}
