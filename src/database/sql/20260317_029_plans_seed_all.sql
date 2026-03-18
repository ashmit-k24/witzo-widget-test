-- Ensure all four plans exist with complete, up-to-date feature data.
-- Uses INSERT ... ON CONFLICT DO UPDATE so this is safe to re-run.

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
    '{
      "displayFeatures": [
        "15 website pages",
        "4 documents",
        "100 monthly conversations",
        "3 chat history",
        "3 leads storage",
        "Basic widget customization",
        "Email support"
      ],
      "capabilities": {
        "websitePagesLimit": 15,
        "documentLimit": 4,
        "chatHistoryLimit": 3,
        "leadStorageLimit": 3,
        "supportedWebsitesLimit": 1,
        "widgetInstancesLimit": 1,
        "teamMembersLimit": 1,
        "fallbackLeadForm": false,
        "chatRating": false,
        "autoFollowUpEmail": false,
        "crmIntegration": false,
        "multiLanguageSupport": false,
        "apiAccess": false,
        "customAiBehavior": false,
        "whiteLabel": false,
        "onboardingAssistance": false,
        "widgetCustomizationTier": "basic",
        "analyticsTier": "basic",
        "supportTier": "email"
      }
    }'::jsonb,
    TRUE
  ),
  (
    'basic',
    'Best for small businesses',
    2000,
    20000,
    '{
      "displayFeatures": [
        "30 website pages",
        "10 documents",
        "1000 monthly conversations",
        "10 chat history",
        "10 leads storage",
        "Fallback lead form",
        "Chat rating",
        "Auto follow-up email",
        "Priority email support"
      ],
      "capabilities": {
        "websitePagesLimit": 30,
        "documentLimit": 10,
        "chatHistoryLimit": 10,
        "leadStorageLimit": 10,
        "supportedWebsitesLimit": 1,
        "widgetInstancesLimit": 1,
        "teamMembersLimit": 2,
        "fallbackLeadForm": true,
        "chatRating": true,
        "autoFollowUpEmail": true,
        "crmIntegration": false,
        "multiLanguageSupport": false,
        "apiAccess": false,
        "customAiBehavior": false,
        "whiteLabel": false,
        "onboardingAssistance": false,
        "widgetCustomizationTier": "standard",
        "analyticsTier": "standard",
        "supportTier": "priority_email"
      }
    }'::jsonb,
    TRUE
  ),
  (
    'standard',
    'Best for growing teams',
    6000,
    60000,
    '{
      "displayFeatures": [
        "100 website pages",
        "50 documents",
        "5000 monthly conversations",
        "Full chat history",
        "Unlimited leads",
        "3 supported websites",
        "5 team members",
        "CRM integrations",
        "Multi-language support",
        "Advanced analytics",
        "Onboarding assistance",
        "Priority email support"
      ],
      "capabilities": {
        "websitePagesLimit": 100,
        "documentLimit": 50,
        "chatHistoryLimit": null,
        "leadStorageLimit": null,
        "supportedWebsitesLimit": 3,
        "widgetInstancesLimit": 3,
        "teamMembersLimit": 5,
        "fallbackLeadForm": true,
        "chatRating": true,
        "autoFollowUpEmail": true,
        "crmIntegration": true,
        "multiLanguageSupport": true,
        "apiAccess": false,
        "customAiBehavior": false,
        "whiteLabel": false,
        "onboardingAssistance": true,
        "widgetCustomizationTier": "advanced",
        "analyticsTier": "advanced",
        "supportTier": "priority_email"
      }
    }'::jsonb,
    TRUE
  ),
  (
    'enterprise',
    'Built for scaling businesses',
    0,
    0,
    '{
      "displayFeatures": [
        "Unlimited website pages",
        "Unlimited documents",
        "Custom conversation limits",
        "Unlimited chat history",
        "Unlimited leads",
        "Unlimited websites",
        "Unlimited team members",
        "Advanced CRM integrations",
        "Multi-language support",
        "API access",
        "Custom AI behavior",
        "White-label",
        "Onboarding assistance",
        "Dedicated support"
      ],
      "capabilities": {
        "websitePagesLimit": null,
        "documentLimit": null,
        "chatHistoryLimit": null,
        "leadStorageLimit": null,
        "supportedWebsitesLimit": null,
        "widgetInstancesLimit": null,
        "teamMembersLimit": null,
        "fallbackLeadForm": true,
        "chatRating": true,
        "autoFollowUpEmail": true,
        "crmIntegration": true,
        "multiLanguageSupport": true,
        "apiAccess": true,
        "customAiBehavior": true,
        "whiteLabel": true,
        "onboardingAssistance": true,
        "widgetCustomizationTier": "advanced",
        "analyticsTier": "advanced",
        "supportTier": "dedicated"
      }
    }'::jsonb,
    TRUE
  )
ON CONFLICT (name) DO UPDATE SET
  description        = EXCLUDED.description,
  monthly_price      = EXCLUDED.monthly_price,
  yearly_price       = EXCLUDED.yearly_price,
  features           = EXCLUDED.features,
  is_active          = EXCLUDED.is_active,
  updated_at         = CURRENT_TIMESTAMP;
