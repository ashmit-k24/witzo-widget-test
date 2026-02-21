ALTER TABLE users
DROP CONSTRAINT IF EXISTS plan_type_check;

ALTER TABLE users
ADD CONSTRAINT plan_type_check CHECK (
  plan_type IN ('free', 'basic', 'enterprise')
);

ALTER TABLE users
ALTER COLUMN conversations_limit SET DEFAULT 100;

UPDATE users
SET conversations_limit = 100
WHERE plan_type = 'free'
  AND conversations_limit IS DISTINCT FROM 100;

UPDATE users
SET conversations_limit = 1000
WHERE plan_type = 'basic'
  AND conversations_limit < 1000;

ALTER TABLE subscriptions
DROP CONSTRAINT IF EXISTS sub_plan_type_check;

ALTER TABLE subscriptions
ADD CONSTRAINT sub_plan_type_check CHECK (
  plan_type IN ('free', 'basic', 'enterprise')
);
