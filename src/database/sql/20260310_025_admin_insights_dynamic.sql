-- Adds supporting tables for admin insights and RAG health metrics

CREATE TABLE IF NOT EXISTS rag_source_pages (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('document', 'website')),
  source_root TEXT,
  source_url TEXT NOT NULL,
  title TEXT,
  chunks INTEGER NOT NULL DEFAULT 0,
  scraped_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_source_pages_user_url
  ON rag_source_pages(user_id, source_url);
CREATE INDEX IF NOT EXISTS idx_rag_source_pages_type
  ON rag_source_pages(source_type);
CREATE INDEX IF NOT EXISTS idx_rag_source_pages_root
  ON rag_source_pages(source_root);

DROP TRIGGER IF EXISTS update_rag_source_pages_updated_at ON rag_source_pages;
CREATE TRIGGER update_rag_source_pages_updated_at
BEFORE UPDATE ON rag_source_pages
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS feature_flags (
  id SERIAL PRIMARY KEY,
  flag_key VARCHAR(120) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_feature_flags_updated_at ON feature_flags;
CREATE TRIGGER update_feature_flags_updated_at
BEFORE UPDATE ON feature_flags
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS compliance_requests (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'open',
  request_type VARCHAR(100),
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_status
  ON compliance_requests(status);
CREATE INDEX IF NOT EXISTS idx_compliance_requests_completed_at
  ON compliance_requests(completed_at DESC);
