CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_key_id INTEGER REFERENCES widget_keys(id) ON DELETE SET NULL,
  visitor_id VARCHAR(128),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  last_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_chat_conversations_user_last_message
  ON chat_conversations(user_id, last_message_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_widget_visitor_last_message
  ON chat_conversations(widget_key_id, visitor_id, last_message_at DESC)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_conversations_status_last_message
  ON chat_conversations(status, last_message_at DESC)
  WHERE is_deleted = FALSE;

DROP TRIGGER IF EXISTS update_chat_conversations_updated_at ON chat_conversations;
CREATE TRIGGER update_chat_conversations_updated_at
BEFORE UPDATE ON chat_conversations
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY,
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  token_count INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE IF NOT EXISTS chat_messages_default
  PARTITION OF chat_messages DEFAULT;

DO $$
DECLARE
  month_start DATE := date_trunc('month', CURRENT_DATE)::date;
  next_month DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month')::date;
  month_after_next DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '2 month')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS chat_messages_%s PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
    to_char(month_start, 'YYYYMM'),
    month_start::text,
    next_month::text
  );

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS chat_messages_%s PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
    to_char(next_month, 'YYYYMM'),
    next_month::text,
    month_after_next::text
  );
END $$;

CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_created
  ON chat_messages(conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
  ON chat_messages(user_id, created_at DESC, id DESC);
