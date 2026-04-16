-- Add pending_delete flag to scraper_sources.
-- Set to TRUE the moment a delete job is queued so the source is hidden from
-- the sources list immediately, even if the background deletion takes time.
-- The row is deleted on success; flag is reset to FALSE on failure.
ALTER TABLE scraper_sources
  ADD COLUMN IF NOT EXISTS pending_delete BOOLEAN NOT NULL DEFAULT FALSE;
