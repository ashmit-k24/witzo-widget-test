-- Migration: Change user ID from SERIAL (integer) to UUID (string)
-- This script will migrate existing user IDs to UUID format

BEGIN;

-- 1. Add a new UUID column to users table
ALTER TABLE users ADD COLUMN new_id UUID DEFAULT gen_random_uuid();

-- 2. Update the new_id column to have unique UUIDs for all existing users
UPDATE users SET new_id = gen_random_uuid() WHERE new_id IS NULL;

-- 3. Add a new user_id_new column to verification_codes table
ALTER TABLE verification_codes ADD COLUMN user_id_new UUID;

-- 4. Update verification_codes to reference the new UUID
UPDATE verification_codes vc
SET user_id_new = u.new_id
FROM users u
WHERE vc.user_id = u.id;

-- 5. Add a new user_id_new column to sessions table
ALTER TABLE sessions ADD COLUMN user_id_new UUID;

-- 6. Update sessions to reference the new UUID
UPDATE sessions s
SET user_id_new = u.new_id
FROM users u
WHERE s.user_id = u.id;

-- 7. Drop old foreign key constraints
ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_user_id_fkey;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_fkey;

-- 8. Drop old columns
ALTER TABLE verification_codes DROP COLUMN user_id;
ALTER TABLE sessions DROP COLUMN user_id;

-- 9. Rename new columns to original names
ALTER TABLE verification_codes RENAME COLUMN user_id_new TO user_id;
ALTER TABLE sessions RENAME COLUMN user_id_new TO user_id;

-- 10. Drop old primary key and id column from users
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey;
ALTER TABLE users DROP COLUMN id;

-- 11. Rename new_id to id
ALTER TABLE users RENAME COLUMN new_id TO id;

-- 12. Set the new id column as primary key
ALTER TABLE users ADD PRIMARY KEY (id);

-- 13. Make user_id NOT NULL in related tables
ALTER TABLE verification_codes ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE sessions ALTER COLUMN user_id SET NOT NULL;

-- 14. Re-add foreign key constraints
ALTER TABLE verification_codes
  ADD CONSTRAINT verification_codes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- 15. Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_verification_codes_user_id ON verification_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

COMMIT;

-- Note: If you encounter any errors, the transaction will be rolled back automatically
-- You may need to backup your database before running this migration
