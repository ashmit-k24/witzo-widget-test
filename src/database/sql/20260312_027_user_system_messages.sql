ALTER TABLE users
  ADD COLUMN IF NOT EXISTS custom_system_message TEXT,
  ADD COLUMN IF NOT EXISTS use_default_system_message BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS system_message_configured BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users
SET use_default_system_message = TRUE
WHERE use_default_system_message IS DISTINCT FROM TRUE
  AND (custom_system_message IS NULL OR btrim(custom_system_message) = '');

UPDATE users
SET system_message_configured = TRUE,
    onboarding_step = GREATEST(onboarding_step, 4),
    onboarding_completed = TRUE,
    onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP)
WHERE onboarding_completed = TRUE
   OR id IN (SELECT DISTINCT user_id FROM widget_keys);
