-- Migration: 051 — Clear old custom system messages and assign default persona
--
-- Purpose:
--   Old users trained their widget with a custom_system_message.
--   The new persona system (widget_personas table) replaces that concept.
--   This migration:
--     1. Clears custom_system_message for every user who has one → reverts to platform default
--     2. Assigns 'general_information' persona to any widget that has no personaKey yet
--
-- To assign a different persona instead of 'general_information', replace the
-- value in jsonb_set(..., '"general_information"') below with one of:
--   '"sales"' | '"customer_support"' | '"ecommerce"' | '"website_information"' | '"general_information"'
--
-- Safe to run multiple times (idempotent).

-- ─────────────────────────────────────────────────────────────
-- Step 1: Clear old custom system messages
-- ─────────────────────────────────────────────────────────────
UPDATE users
SET
    custom_system_message       = NULL,
    use_default_system_message  = TRUE,
    updated_at                  = CURRENT_TIMESTAMP
WHERE
    custom_system_message IS NOT NULL
    AND btrim(custom_system_message) != '';

-- ─────────────────────────────────────────────────────────────
-- Step 2: Assign default persona to widgets that have none yet
-- Preserves existing personaKey if already set — only fills the gap.
-- ─────────────────────────────────────────────────────────────
UPDATE widget_keys
SET
    widget_config = jsonb_set(
        COALESCE(widget_config, '{}'::jsonb),
        '{personaKey}',
        '"general_information"'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE
    (widget_config IS NULL)
    OR (widget_config->>'personaKey' IS NULL)
    OR (btrim(widget_config->>'personaKey') = '');
