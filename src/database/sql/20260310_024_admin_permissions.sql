ALTER TABLE admin_users
ADD COLUMN IF NOT EXISTS permissions JSONB NULL;

ALTER TABLE admin_users
ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES admin_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_admin_users_created_by
  ON admin_users (created_by);
