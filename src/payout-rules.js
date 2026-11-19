export function remainingPayoutLimit(profit, reserved, profitShare = 0.8) {
  const p = Number(profit), r = Number(reserved), share = Number(profitShare);
  if (!Number.isFinite(p) || !Number.isFinite(r) || !Number.isFinite(share) || p <= 0 || r < 0 || share <= 0 || share > 1) return 0;
  return Math.max(0, p * share - r);
}

export function isAllowedPayoutTransition(current, next) {
  return (current === "pending" && (next === "approved" || next === "rejected"))
    || (current === "approved" && next === "paid");
}
