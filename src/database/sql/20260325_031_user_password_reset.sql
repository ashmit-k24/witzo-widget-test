ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_reset_token_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS password_reset_requested_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_expires
  ON users(password_reset_token_expires_at);
