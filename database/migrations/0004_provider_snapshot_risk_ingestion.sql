PRAGMA foreign_keys = ON;

-- Provider feed synchronization state.
ALTER TABLE challenges ADD COLUMN trading_days_count INTEGER NOT NULL DEFAULT 0 CHECK (trading_days_count >= 0);
ALTER TABLE challenges ADD COLUMN last_provider_snapshot_at TEXT;

-- Idempotency ledger for provider snapshot event IDs, including source timestamp.
CREATE TABLE IF NOT EXISTS provider_snapshot_events (
  event_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  provider_timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_provider_snapshot_events_challenge
  ON provider_snapshot_events(challenge_id, received_at);
