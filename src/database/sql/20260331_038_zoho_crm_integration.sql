CREATE TABLE IF NOT EXISTS zoho_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT,
  organization_name TEXT,
  api_domain TEXT,
  accounts_server TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  scope TEXT,
  token_expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  lead_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  note_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_zoho_integrations_user_active
  ON zoho_integrations(user_id, is_active);

DROP TRIGGER IF EXISTS update_zoho_integrations_updated_at ON zoho_integrations;
CREATE TRIGGER update_zoho_integrations_updated_at
BEFORE UPDATE ON zoho_integrations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS zoho_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  integration_id UUID NOT NULL REFERENCES zoho_integrations(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts >= 1),
  next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  response_status INTEGER,
  last_attempt_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT zoho_sync_events_status_check
    CHECK (status IN ('pending', 'processing', 'retrying', 'delivered', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_zoho_sync_events_user_created
  ON zoho_sync_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_zoho_sync_events_pending
  ON zoho_sync_events(status, next_attempt_at);

DROP TRIGGER IF EXISTS update_zoho_sync_events_updated_at ON zoho_sync_events;
CREATE TRIGGER update_zoho_sync_events_updated_at
BEFORE UPDATE ON zoho_sync_events
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
