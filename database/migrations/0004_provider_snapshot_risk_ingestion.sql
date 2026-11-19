PRAGMA foreign_keys = ON;

-- Trading-day count is supplied by the trusted MT5/provider integration.
ALTER TABLE challenges ADD COLUMN trading_days_count INTEGER NOT NULL DEFAULT 0 CHECK (trading_days_count >= 0);

-- Idempotency ledger for provider snapshot event IDs.
CREATE TABLE IF NOT EXISTS provider_snapshot_events (
  event_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_provider_snapshot_events_challenge
  ON provider_snapshot_events(challenge_id, received_at);
