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
    'Best for testing Witzo',
    0,
    0,
    '[
      "15 website pages",
      "4 documents",
      "100 conversations",
      "3 chat history",
      "3 leads storage",
      "Basic widget customization"
    ]'::jsonb,
    TRUE
  ),
  (
    'basic',
    'Best for small businesses',
    2000,
    20000,
    '[
      "30 website pages",
      "10 documents",
      "1000 monthly conversations",
      "10 chat history",
      "10 leads storage",
      "Fallback lead form",
      "Chat rating",
      "Auto follow-up email",
      "Lead webhook"
    ]'::jsonb,
    TRUE
  ),
  (
    'standard',
    'Best for growing teams',
    6000,
    60000,
    '[
      "100 website pages",
      "50 documents",
      "5000 monthly conversations",
      "Full chat history",
      "Unlimited leads",
      "CRM integrations",
      "Advanced analytics"
    ]'::jsonb,
    TRUE
  ),
  (
    'enterprise',
    'Built for scaling businesses',
    0,
    0,
    '[
      "Unlimited website pages",
      "Unlimited documents",
      "Custom conversation limits",
      "Unlimited chat history",
      "Unlimited leads",
      "Advanced CRM integrations",
      "White-label",
      "API access",
      "Custom AI behavior"
    ]'::jsonb,
    TRUE
  )
ON CONFLICT (name) DO UPDATE
SET
  description = EXCLUDED.description,
  monthly_price = EXCLUDED.monthly_price,
  yearly_price = EXCLUDED.yearly_price,
  features = EXCLUDED.features,
  is_active = EXCLUDED.is_active,
  updated_at = CURRENT_TIMESTAMP;
