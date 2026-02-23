ALTER TABLE users
ALTER COLUMN conversations_limit DROP NOT NULL;

UPDATE users
SET conversations_limit = NULL
WHERE plan_type = 'enterprise';
