CREATE TABLE IF NOT EXISTS lead_webhook_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  webhook_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lead_webhook_configs_user_id
  ON lead_webhook_configs(user_id);

DROP TRIGGER IF EXISTS update_lead_webhook_configs_updated_at ON lead_webhook_configs;
CREATE TRIGGER update_lead_webhook_configs_updated_at
BEFORE UPDATE ON lead_webhook_configs
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS lead_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  config_id UUID NOT NULL REFERENCES lead_webhook_configs(id) ON DELETE CASCADE,
  event_type VARCHAR(80) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 8,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  response_status INTEGER,
  last_attempt_at TIMESTAMP,
  delivered_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT lead_webhook_events_status_check
    CHECK (status IN ('pending', 'processing', 'retrying', 'delivered', 'dead'))
);

CREATE INDEX IF NOT EXISTS idx_lead_webhook_events_user_created
  ON lead_webhook_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_webhook_events_pending
  ON lead_webhook_events(status, next_attempt_at);

DROP TRIGGER IF EXISTS update_lead_webhook_events_updated_at ON lead_webhook_events;
CREATE TRIGGER update_lead_webhook_events_updated_at
BEFORE UPDATE ON lead_webhook_events
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
