-- Add onboarding tracking fields to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_step         INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS onboarding_completed    BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMP;

-- Backfill: users who already have a widget are considered fully onboarded
UPDATE users
SET onboarding_step         = 3,
    onboarding_completed    = TRUE,
    onboarding_completed_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT DISTINCT user_id FROM widget_keys);
