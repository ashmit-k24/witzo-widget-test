CREATE TABLE IF NOT EXISTS disallowed_domains (
  id SERIAL PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_disallowed_domains_domain
  ON disallowed_domains(domain);

DROP TRIGGER IF EXISTS update_disallowed_domains_updated_at ON disallowed_domains;
CREATE TRIGGER update_disallowed_domains_updated_at
BEFORE UPDATE ON disallowed_domains
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
