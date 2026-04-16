CREATE TABLE IF NOT EXISTS chat_message_feedback (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  widget_key_id INTEGER REFERENCES widget_keys(id) ON DELETE SET NULL,
  message_id BIGINT NOT NULL,
  feedback_type VARCHAR(10) NOT NULL CHECK (feedback_type IN ('up', 'down')),
  feedback_reason VARCHAR(100),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chat_message_feedback_unique UNIQUE (user_id, session_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_feedback_session
  ON chat_message_feedback(user_id, session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_message_feedback_message
  ON chat_message_feedback(user_id, message_id);

DROP TRIGGER IF EXISTS update_chat_message_feedback_updated_at ON chat_message_feedback;
CREATE TRIGGER update_chat_message_feedback_updated_at
BEFORE UPDATE ON chat_message_feedback
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
