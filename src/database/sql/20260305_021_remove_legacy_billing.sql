-- Remove legacy payment-provider schema artifacts.
-- Safe to run multiple times.

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;

DROP TABLE IF EXISTS payment_history;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'subscriptions'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'subscriptions'
        AND column_name = 'razorpay_subscription_id'
    ) THEN
      RAISE NOTICE 'Skipping subscriptions drop because the current table is the newer Razorpay billing schema.';
    ELSE
      EXECUTE 'DROP TABLE subscriptions CASCADE';
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_users_stripe_customer;

ALTER TABLE users
DROP COLUMN IF EXISTS stripe_customer_id,
DROP COLUMN IF EXISTS subscription_id,
DROP COLUMN IF EXISTS subscription_status;
