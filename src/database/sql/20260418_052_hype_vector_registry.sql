-- Stores the Pinecone vector IDs created during HyPE generation so that
-- subsequent HyPE runs can delete old vectors by ID directly, avoiding the
-- O(total_namespace_vectors) scan in forEachUserRecord.
CREATE TABLE IF NOT EXISTS hype_vector_registry (
  user_id    UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_url TEXT    NOT NULL,
  vector_ids TEXT[]  NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, source_url)
);

CREATE INDEX IF NOT EXISTS idx_hype_vector_registry_user
  ON hype_vector_registry(user_id);
