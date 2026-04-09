-- Track pages visited by a widget visitor during a chat session
CREATE TABLE IF NOT EXISTS session_page_views (
    id          BIGSERIAL PRIMARY KEY,
    session_id  TEXT        NOT NULL,
    user_id     TEXT        NOT NULL,
    url         TEXT        NOT NULL,
    viewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_page_views_session_id
    ON session_page_views (session_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_page_views_user_id
    ON session_page_views (user_id, viewed_at DESC);
