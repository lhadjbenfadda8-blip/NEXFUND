# MT5 Provider Snapshot Ingestion

This endpoint is the authenticated server-side bridge from an MT5/provider adapter into the NEXFUND challenge risk evaluator. It is **not** a direct MT5 connection and should only be called by a trusted adapter running on infrastructure that can protect the shared secret.

## Prerequisites
1. Apply migration `database/migrations/0004_provider_snapshot_risk_ingestion.sql` to the Cloudflare D1 database before deploying this Worker version.
2. Set Worker secret `NEXFUND_PROVIDER_SYNC_SECRET` to a random value of at least 32 characters.
3. Provision MT5 accounts through the configured provider; the account login must already be mapped to the challenge in `trading_accounts`.
4. Keep the provider adapter's secret off browsers, trader clients, and source control.

## Request
`POST /api/internal/provider/snapshot`

Headers:
- `Authorization: Bearer <NEXFUND_PROVIDER_SYNC_SECRET>`
- `Content-Type: application/json`

Body:
```json
{
  "event_id": "provider-unique-snapshot-event",
  "snapshot_at": "2026-11-19T03:20:00.000Z",
  "challenge_id": "challenge-uuid",
  "login": "12345678",
  "balance": 10025.50,
  "equity": 10020.25,
  "daily_start_equity": 10000,
  "daily_start_date": "2026-11-19",
  "trading_days": 4
}
```

The event ID must be unique per provider snapshot. The login is checked against the mapped trading account. Snapshot fields are validated. Only challenges already in `active` status accept snapshots. The endpoint updates balances, equity, high-watermark, daily baseline/date, trading-day count, connection status and last sync time, evaluates daily loss, static maximum loss and profit target/minimum trading days, writes risk events, and notifies the trader when a terminal pass/fail decision occurs.

Repeated event IDs return a duplicate acknowledgement (reusing an event ID for a different challenge is rejected). Snapshot timestamps must not be in the future beyond a small clock-skew allowance or precede the last accepted snapshot. Terminal challenge states do not accept later snapshots. The endpoint does not accept a trader session as provider authentication.

## Drawdown basis
- Daily loss: `daily_start_equity` supplied by the trusted adapter.
- Overall maximum loss: static percentage of challenge initial balance.
- Profit target: equity relative to initial balance.
- Minimum trading days: provider snapshot's count.

## Important limitations
- No provider adapter has been connected yet; this endpoint is only the receiver.
- Provider authenticity, event ID uniqueness, snapshot cadence, daily reset rules, and the adapter's MT5 account monitoring must be implemented and verified on the provider side.
- Migration must be applied before the endpoint is used. The source repository's migration is not automatically applied by a code commit.
- This is an evaluation/simulation workflow; it does not authorize or create real-money trading.
