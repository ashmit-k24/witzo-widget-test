ALTER TABLE users
  ADD COLUMN IF NOT EXISTS knowledge_boundary TEXT NOT NULL DEFAULT 'workspace_only';

UPDATE users
SET knowledge_boundary = 'workspace_only'
WHERE knowledge_boundary IS NULL
   OR btrim(knowledge_boundary) = '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_knowledge_boundary_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_knowledge_boundary_check
      CHECK (knowledge_boundary IN ('workspace_only', 'workspace_prefer', 'general_allowed'));
  END IF;
END $$;
