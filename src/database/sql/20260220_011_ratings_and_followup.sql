-- Migration: 20260220_011_ratings_and_followup
-- Adds follow-up email tracking to leads and creates chat_ratings table

-- 1. Add follow-up sent timestamp to leads table
ALTER TABLE leads
	ADD COLUMN IF NOT EXISTS follow_up_sent_at TIMESTAMP DEFAULT NULL;

-- 2. Create chat ratings table (one rating per session per widget owner)
CREATE TABLE IF NOT EXISTS chat_ratings (
	id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	session_id    VARCHAR(255) NOT NULL,
	widget_key_id INTEGER      REFERENCES widget_keys(id) ON DELETE SET NULL,
	rating        VARCHAR(10)  NOT NULL CHECK (rating IN ('up', 'down')),
	created_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_ratings_user_id
	ON chat_ratings(user_id);

CREATE INDEX IF NOT EXISTS idx_chat_ratings_created_at
	ON chat_ratings(user_id, created_at DESC);
