-- visitor_profiles: cross-session lead identity keyed by browser-generated visitorId
-- The widget stores a UUID in localStorage and sends it with every chat message.
-- This table merges lead data across sessions for the same visitor so we never
-- re-ask for name/email/phone the visitor already provided in a prior session.

CREATE TABLE IF NOT EXISTS visitor_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id      VARCHAR(255) NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            VARCHAR(255),
  email           VARCHAR(255),
  phone           VARCHAR(50),
  source_session  VARCHAR(255),
  first_seen_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (visitor_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_visitor_profiles_visitor_id ON visitor_profiles (visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitor_profiles_user_id    ON visitor_profiles (user_id);
CREATE INDEX IF NOT EXISTS idx_visitor_profiles_email      ON visitor_profiles (email) WHERE email IS NOT NULL;

DROP TRIGGER IF EXISTS update_visitor_profiles_updated_at ON visitor_profiles;
CREATE TRIGGER update_visitor_profiles_updated_at
BEFORE UPDATE ON visitor_profiles
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
