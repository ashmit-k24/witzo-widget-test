CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_key_id INTEGER REFERENCES widget_keys(id) ON DELETE SET NULL,
  session_id VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  country VARCHAR(100),
  company VARCHAR(255),
  chat_summary TEXT,
  raw_contact JSONB DEFAULT '{}'::jsonb,
  status VARCHAR(50) DEFAULT 'new',
  source_url TEXT,
  ip_address VARCHAR(45),
  message_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(user_id, status);

DROP TRIGGER IF EXISTS update_leads_updated_at ON leads;
CREATE TRIGGER update_leads_updated_at
BEFORE UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
