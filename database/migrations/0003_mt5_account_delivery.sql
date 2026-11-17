PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS mt5_account_deliveries (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  encrypted_password TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','failed')),
  provider_account_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  emailed_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_mt5_delivery_user
  ON mt5_account_deliveries(user_id, created_at);
