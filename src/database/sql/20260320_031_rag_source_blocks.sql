CREATE TABLE IF NOT EXISTS rag_source_blocks (
  id BIGSERIAL PRIMARY KEY,
  source_page_id BIGINT REFERENCES rag_source_pages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL CHECK (source_type IN ('document', 'website')),
  source_root TEXT,
  source_url TEXT NOT NULL,
  title TEXT,
  page_type VARCHAR(60),
  block_type VARCHAR(60),
  section_title TEXT,
  section_path TEXT[],
  position INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  scraped_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_user_url
  ON rag_source_blocks(user_id, source_url);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_page_type
  ON rag_source_blocks(user_id, page_type);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_block_type
  ON rag_source_blocks(user_id, block_type);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_source_root
  ON rag_source_blocks(user_id, source_root);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_position
  ON rag_source_blocks(source_page_id, position);

CREATE INDEX IF NOT EXISTS idx_rag_source_blocks_search
  ON rag_source_blocks
  USING GIN (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' ||
      coalesce(section_title, '') || ' ' ||
      coalesce(content, '') || ' ' ||
      coalesce(source_url, '')
    )
  );

DROP TRIGGER IF EXISTS update_rag_source_blocks_updated_at ON rag_source_blocks;
CREATE TRIGGER update_rag_source_blocks_updated_at
BEFORE UPDATE ON rag_source_blocks
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
