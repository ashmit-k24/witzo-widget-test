DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'sessions'
      AND column_name = 'session_token'
  ) THEN
    DROP TABLE IF EXISTS sessions CASCADE;

    CREATE TABLE sessions (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token VARCHAR(64) NOT NULL,
      access_token_expires_at TIMESTAMP NOT NULL,
      refresh_token_expires_at TIMESTAMP NOT NULL,
      is_revoked BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45),
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_access_token ON sessions(access_token);
    CREATE INDEX IF NOT EXISTS idx_sessions_refresh_token ON sessions(refresh_token);
    CREATE INDEX IF NOT EXISTS idx_sessions_refresh_expires ON sessions(refresh_token_expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_is_revoked ON sessions(is_revoked);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, is_revoked) WHERE is_revoked = FALSE;

    DROP TRIGGER IF EXISTS update_sessions_updated_at ON sessions;
    CREATE TRIGGER update_sessions_updated_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

