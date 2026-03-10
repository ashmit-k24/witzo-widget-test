ALTER TABLE users
DROP CONSTRAINT IF EXISTS plan_type_check;

ALTER TABLE users
ADD CONSTRAINT plan_type_check CHECK (
  plan_type IN ('free', 'basic', 'standard', 'enterprise')
);

UPDATE users
SET conversations_limit = 100
WHERE plan_type = 'free'
  AND conversations_limit IS DISTINCT FROM 100;

UPDATE users
SET conversations_limit = 1000
WHERE plan_type = 'basic'
  AND conversations_limit IS DISTINCT FROM 1000;

UPDATE users
SET conversations_limit = 5000
WHERE plan_type = 'standard'
  AND conversations_limit IS DISTINCT FROM 5000;

UPDATE users
SET conversations_limit = NULL
WHERE plan_type = 'enterprise'
  AND conversations_limit IS NOT NULL;

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
    'standard',
    'Best for growing teams',
    6000,
    60000,
    '[
      "100 website pages",
      "50 documents",
      "5000 monthly conversations",
      "Unlimited leads",
      "CRM integrations",
      "Advanced analytics"
    ]'::jsonb,
    TRUE
  )
ON CONFLICT (name) DO NOTHING;

UPDATE plans
SET
  description = CASE name
    WHEN 'free' THEN 'Best for testing Witzo'
    WHEN 'basic' THEN 'Best for small businesses'
    WHEN 'standard' THEN 'Best for growing teams'
    WHEN 'enterprise' THEN 'Built for scaling businesses'
    ELSE description
  END,
  monthly_price = CASE name
    WHEN 'free' THEN 0
    WHEN 'basic' THEN 2000
    WHEN 'standard' THEN 6000
    WHEN 'enterprise' THEN 0
    ELSE monthly_price
  END,
  yearly_price = CASE name
    WHEN 'free' THEN 0
    WHEN 'basic' THEN 20000
    WHEN 'standard' THEN 60000
    WHEN 'enterprise' THEN 0
    ELSE yearly_price
  END,
  features = CASE name
    WHEN 'free' THEN '[
      "15 website pages",
      "4 documents",
      "100 conversations",
      "3 chat history",
      "3 leads storage",
      "Basic widget customization"
    ]'::jsonb
    WHEN 'basic' THEN '[
      "30 website pages",
      "10 documents",
      "1000 monthly conversations",
      "10 chat history",
      "10 leads storage",
      "Fallback lead form",
      "Chat rating",
      "Auto follow-up email"
    ]'::jsonb
    WHEN 'standard' THEN '[
      "100 website pages",
      "50 documents",
      "5000 monthly conversations",
      "Full chat history",
      "Unlimited leads",
      "CRM integrations",
      "Advanced analytics"
    ]'::jsonb
    WHEN 'enterprise' THEN '[
      "Unlimited website pages",
      "Unlimited documents",
      "Custom conversation limits",
      "Unlimited chat history",
      "Unlimited leads",
      "Advanced CRM integrations",
      "White-label",
      "API access",
      "Custom AI behavior"
    ]'::jsonb
    ELSE features
  END,
  updated_at = CURRENT_TIMESTAMP
WHERE name IN ('free', 'basic', 'standard', 'enterprise');
