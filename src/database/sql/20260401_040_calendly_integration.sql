CREATE TABLE IF NOT EXISTS calendly_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    calendly_user_uri TEXT,
    calendly_user_name VARCHAR(255),
    calendly_user_email VARCHAR(320),
    organization_uri TEXT,
    scheduling_url TEXT,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    scope TEXT,
    token_expires_at TIMESTAMPTZ,
    webhook_subscription_uri TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    widget_booking_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    booking_intent_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    booking_label VARCHAR(120) NOT NULL DEFAULT 'Book an appointment',
    selected_event_type_uri TEXT,
    selected_event_type_name VARCHAR(255),
    selected_scheduling_url TEXT,
    last_synced_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_calendly_integrations_active
    ON calendly_integrations (user_id, is_active);

CREATE TABLE IF NOT EXISTS calendly_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    integration_id UUID NOT NULL REFERENCES calendly_integrations(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    session_id UUID,
    widget_key_id INTEGER REFERENCES widget_keys(id) ON DELETE SET NULL,
    event_type_uri TEXT,
    scheduled_event_uri TEXT NOT NULL UNIQUE,
    scheduled_event_name VARCHAR(255),
    invitee_uri TEXT,
    invitee_name VARCHAR(255),
    invitee_email VARCHAR(320),
    invitee_timezone VARCHAR(120),
    status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    cancel_url TEXT,
    reschedule_url TEXT,
    tracking_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(32) NOT NULL DEFAULT 'webhook',
    canceled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_calendly_appointments_user_created
    ON calendly_appointments (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_calendly_appointments_session
    ON calendly_appointments (session_id);

CREATE INDEX IF NOT EXISTS idx_calendly_appointments_lead
    ON calendly_appointments (lead_id);
