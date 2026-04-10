CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  requested_ip TEXT,
  requested_user_agent TEXT,
  failure_reason TEXT,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_user_id
  ON account_deletion_requests (user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_account_deletion_requests_status
  ON account_deletion_requests (status, requested_at DESC);

DROP TRIGGER IF EXISTS update_account_deletion_requests_updated_at ON account_deletion_requests;
CREATE TRIGGER update_account_deletion_requests_updated_at
BEFORE UPDATE ON account_deletion_requests
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
