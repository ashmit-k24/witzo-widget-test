CREATE TABLE IF NOT EXISTS widget_keys (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  widget_key VARCHAR(255) UNIQUE NOT NULL,
  widget_name VARCHAR(255) DEFAULT 'My Chat Widget',
  is_active BOOLEAN DEFAULT TRUE,
  allowed_domains TEXT[],
  widget_config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  usage_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_widget_keys_user_id ON widget_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_widget_keys_key ON widget_keys(widget_key);
CREATE INDEX IF NOT EXISTS idx_widget_keys_active ON widget_keys(is_active);

DROP TRIGGER IF EXISTS update_widget_keys_updated_at ON widget_keys;
CREATE TRIGGER update_widget_keys_updated_at
BEFORE UPDATE ON widget_keys
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS widget_analytics (
  id SERIAL PRIMARY KEY,
  widget_key_id INTEGER NOT NULL REFERENCES widget_keys(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL,
  event_data JSONB DEFAULT '{}'::jsonb,
  ip_address VARCHAR(45),
  user_agent TEXT,
  referer_url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_id ON widget_analytics(widget_key_id);
CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_type ON widget_analytics(event_type);
CREATE INDEX IF NOT EXISTS idx_widget_analytics_created_at ON widget_analytics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_analytics_key_created ON widget_analytics(widget_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_widget_analytics_event_created ON widget_analytics(event_type, created_at DESC);

