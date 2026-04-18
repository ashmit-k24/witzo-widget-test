-- Per-user token usage tracking for cost attribution
-- Records every OpenAI completion call with prompt/completion tokens and model.

CREATE TABLE IF NOT EXISTS usage_events (
  id              BIGSERIAL    PRIMARY KEY,
  user_id         UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      UUID,
  model           TEXT         NOT NULL,
  prompt_tokens   INTEGER      NOT NULL DEFAULT 0,
  completion_tokens INTEGER    NOT NULL DEFAULT 0,
  total_tokens    INTEGER      NOT NULL GENERATED ALWAYS AS (prompt_tokens + completion_tokens) STORED,
  source          TEXT         NOT NULL DEFAULT 'chat',
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS usage_events_user_id_created_at_idx
  ON usage_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS usage_events_created_at_idx
  ON usage_events (created_at DESC);
