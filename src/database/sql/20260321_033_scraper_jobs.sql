-- Scraper jobs table — replaces Redis-based job status tracking
CREATE TABLE IF NOT EXISTS scraper_jobs (
  job_id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  url         TEXT        NOT NULL,
  mode        VARCHAR(10) NOT NULL CHECK (mode IN ('scrape', 'retrain')),
  current_url TEXT,
  max_depth   INT         NOT NULL DEFAULT 5,
  max_pages   INT         NOT NULL DEFAULT 100,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  total_pages    INT NOT NULL DEFAULT 0,
  scraped_pages  INT NOT NULL DEFAULT 0,
  stored_pages   INT NOT NULL DEFAULT 0,
  error       TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_jobs_user_id
  ON scraper_jobs (user_id);

CREATE INDEX IF NOT EXISTS idx_scraper_jobs_status
  ON scraper_jobs (status);

CREATE INDEX IF NOT EXISTS idx_scraper_jobs_user_updated
  ON scraper_jobs (user_id, updated_at DESC);
