ALTER TABLE subscriptions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_user_id_fkey;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE payments
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_user_id_fkey;

ALTER TABLE payments
  ADD CONSTRAINT payments_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
