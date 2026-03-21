-- Add workspace_mode column to users table.
-- workspace_only  → AI answers ONLY from scraped context; refuses to use general knowledge.
-- workspace_prefer → AI prefers scraped context but may supplement with general knowledge.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS workspace_mode VARCHAR(20) NOT NULL DEFAULT 'workspace_prefer'
    CONSTRAINT chk_workspace_mode CHECK (workspace_mode IN ('workspace_only', 'workspace_prefer'));
