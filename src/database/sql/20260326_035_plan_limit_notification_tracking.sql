ALTER TABLE users
ADD COLUMN IF NOT EXISTS conversation_limit_email_sent_at TIMESTAMP;
