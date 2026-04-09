CREATE TABLE IF NOT EXISTS scraper_sources (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_title TEXT,
  scraped_pages INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  raw_content TEXT,
  metadata_ready BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_ready_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_scraper_sources_user
  ON scraper_sources(user_id);

DROP TRIGGER IF EXISTS update_scraper_sources_updated_at ON scraper_sources;
CREATE TRIGGER update_scraper_sources_updated_at
BEFORE UPDATE ON scraper_sources
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS scraped_pages (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  page_url TEXT NOT NULL,
  page_title TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, page_url)
);

CREATE INDEX IF NOT EXISTS idx_scraped_pages_user_source
  ON scraped_pages(user_id, source_url);

DROP TRIGGER IF EXISTS update_scraped_pages_updated_at ON scraped_pages;
CREATE TRIGGER update_scraped_pages_updated_at
BEFORE UPDATE ON scraped_pages
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
