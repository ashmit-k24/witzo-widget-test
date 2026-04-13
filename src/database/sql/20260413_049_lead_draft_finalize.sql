ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS capture_status VARCHAR(20) NOT NULL DEFAULT 'draft';

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP NULL;

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS last_synced_signature VARCHAR(128) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'leads_capture_status_check'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_capture_status_check
      CHECK (capture_status IN ('draft', 'finalized'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_leads_capture_status
  ON leads(user_id, capture_status, updated_at DESC);
