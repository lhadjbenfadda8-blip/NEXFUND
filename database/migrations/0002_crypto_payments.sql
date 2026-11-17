-- NEXFUND USDT TRC20 payment intents
-- Apply once to the production D1 database before deploying the payment-enabled Worker.
CREATE TABLE IF NOT EXISTS crypto_payments (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdt REAL NOT NULL CHECK (amount_usdt > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','rejected')),
  txid TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crypto_payments_user ON crypto_payments(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crypto_payments_status ON crypto_payments(status);
