CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  monthly_price INTEGER NOT NULL DEFAULT 0,
  yearly_price INTEGER NOT NULL DEFAULT 0,
  razorpay_monthly_plan_id VARCHAR(255),
  razorpay_yearly_plan_id VARCHAR(255),
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_plans_updated_at ON plans;
CREATE TRIGGER update_plans_updated_at
BEFORE UPDATE ON plans
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  billing_cycle VARCHAR(20) NOT NULL CHECK (billing_cycle IN ('monthly', 'yearly')),
  razorpay_subscription_id VARCHAR(255) UNIQUE NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'created',
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  next_billing_date TIMESTAMP,
  auto_renew BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_at_cycle_end BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
BEFORE UPDATE ON subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_razorpay_sub
  ON subscriptions(razorpay_subscription_id);

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
  razorpay_order_id VARCHAR(255),
  razorpay_payment_id VARCHAR(255) UNIQUE NOT NULL,
  razorpay_signature TEXT,
  amount INTEGER NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  payment_status VARCHAR(50) NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_user_created_at
  ON payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_subscription_created_at
  ON payments(subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_order_id
  ON payments(razorpay_order_id);

INSERT INTO plans (
  name,
  description,
  monthly_price,
  yearly_price,
  features,
  is_active
)
VALUES
  (
    'free',
    'Starter plan for trying Witzo',
    0,
    0,
    '[
      "Up to 100 monthly conversations",
      "Website data source setup",
      "Email support"
    ]'::jsonb,
    TRUE
  ),
  (
    'basic',
    'Growth plan for SMB teams',
    2900,
    29000,
    '[
      "Up to 1000 monthly conversations",
      "Lead capture and dashboard analytics",
      "Priority email support"
    ]'::jsonb,
    TRUE
  ),
  (
    'enterprise',
    'Advanced plan for high-volume teams',
    9900,
    99000,
    '[
      "Unlimited conversations",
      "CRM and webhook integrations",
      "Dedicated support"
    ]'::jsonb,
    TRUE
  )
ON CONFLICT (name) DO NOTHING;
