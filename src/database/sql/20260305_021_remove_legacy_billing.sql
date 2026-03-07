-- Remove legacy payment-provider schema artifacts.
-- Safe to run multiple times.

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;

DROP TABLE IF EXISTS payment_history;
DROP TABLE IF EXISTS subscriptions;

DROP INDEX IF EXISTS idx_users_stripe_customer;

ALTER TABLE users
DROP COLUMN IF EXISTS stripe_customer_id,
DROP COLUMN IF EXISTS subscription_id,
DROP COLUMN IF EXISTS subscription_status;
