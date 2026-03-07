CREATE TABLE IF NOT EXISTS feedback_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('feedback', 'suggestion')),
  title VARCHAR(150),
  message TEXT NOT NULL,
  page_path TEXT,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_suggestions_user_created
  ON feedback_suggestions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_suggestions_user_type
  ON feedback_suggestions(user_id, type);
