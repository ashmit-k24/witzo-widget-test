ALTER TABLE users
ADD COLUMN IF NOT EXISTS plan_type VARCHAR(20) DEFAULT 'free',
ADD COLUMN IF NOT EXISTS conversations_used INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS conversations_limit INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS plan_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'plan_type_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
    ADD CONSTRAINT plan_type_check CHECK (plan_type IN ('free', 'basic'));
  END IF;
END $$;

ALTER TABLE users
ALTER COLUMN conversations_limit SET DEFAULT 100;

CREATE INDEX IF NOT EXISTS idx_users_plan_type ON users(plan_type);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);

