-- Migration: Replace Razorpay billing columns with Paddle equivalents
-- Plans: razorpay_monthly_plan_id / razorpay_yearly_plan_id -> paddle_monthly_price_id / paddle_yearly_price_id
-- Subscriptions: razorpay_subscription_id -> paddle_subscription_id, add paddle_customer_id
-- Payments: razorpay_* columns -> paddle_transaction_id, paddle_customer_id

-- ── plans ──────────────────────────────────────────────────────────────────
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS paddle_monthly_price_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS paddle_yearly_price_id  VARCHAR(255);

ALTER TABLE plans
  DROP COLUMN IF EXISTS razorpay_monthly_plan_id,
  DROP COLUMN IF EXISTS razorpay_yearly_plan_id;

-- ── subscriptions ──────────────────────────────────────────────────────────
-- 1. Drop old unique constraint on razorpay_subscription_id
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_razorpay_subscription_id_key;

-- 2. Drop the old Razorpay index
DROP INDEX IF EXISTS idx_subscriptions_razorpay_sub;

-- 3. Rename razorpay_subscription_id -> paddle_subscription_id (or add if missing)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'subscriptions' AND column_name = 'razorpay_subscription_id'
  ) THEN
    ALTER TABLE subscriptions
      RENAME COLUMN razorpay_subscription_id TO paddle_subscription_id;
    -- Wipe old values so the unique constraint can be applied safely
    UPDATE subscriptions SET paddle_subscription_id = NULL;
    ALTER TABLE subscriptions
      ALTER COLUMN paddle_subscription_id DROP NOT NULL;
  ELSE
    ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS paddle_subscription_id VARCHAR(255);
  END IF;
END;
$$;

-- 4. Add paddle_customer_id
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS paddle_customer_id VARCHAR(255);

-- 5. Re-create index with new name
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_paddle_sub
  ON subscriptions(paddle_subscription_id)
  WHERE paddle_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_paddle_customer
  ON subscriptions(paddle_customer_id);

-- ── payments ───────────────────────────────────────────────────────────────
-- Drop old Razorpay indexes
DROP INDEX IF EXISTS idx_payments_order_id;

DO $$
BEGIN
  -- Drop razorpay_order_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'razorpay_order_id'
  ) THEN
    ALTER TABLE payments DROP COLUMN razorpay_order_id;
  END IF;

  -- Rename razorpay_payment_id -> paddle_transaction_id
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'razorpay_payment_id'
  ) THEN
    ALTER TABLE payments
      RENAME COLUMN razorpay_payment_id TO paddle_transaction_id;
    -- Drop the unique constraint that was on the old column
    ALTER TABLE payments
      DROP CONSTRAINT IF EXISTS payments_razorpay_payment_id_key;
    ALTER TABLE payments
      ADD CONSTRAINT payments_paddle_transaction_id_key UNIQUE (paddle_transaction_id);
  ELSE
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS paddle_transaction_id VARCHAR(255) UNIQUE NOT NULL DEFAULT gen_random_uuid()::text;
  END IF;

  -- Rename razorpay_signature -> paddle_event_id (store Paddle event id for idempotency)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'razorpay_signature'
  ) THEN
    ALTER TABLE payments RENAME COLUMN razorpay_signature TO paddle_event_id;
  ELSE
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS paddle_event_id TEXT;
  END IF;
END;
$$;

-- Add paddle_customer_id to payments
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS paddle_customer_id VARCHAR(255);

-- Update default currency from INR to USD (Paddle is USD-first)
ALTER TABLE payments
  ALTER COLUMN currency SET DEFAULT 'USD';

CREATE INDEX IF NOT EXISTS idx_payments_paddle_transaction
  ON payments(paddle_transaction_id);

CREATE INDEX IF NOT EXISTS idx_payments_paddle_customer
  ON payments(paddle_customer_id);
