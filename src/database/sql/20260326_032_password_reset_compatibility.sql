ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS password_reset_token_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS password_reset_requested_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_expires
  ON users(password_reset_token_expires_at);

DO $$
DECLARE
  legacy_table_exists BOOLEAN;
  token_hash_column TEXT;
  expires_at_column TEXT;
  requested_at_column TEXT;
  order_by_column TEXT;
BEGIN
  SELECT to_regclass('public.password_reset_tokens') IS NOT NULL
    INTO legacy_table_exists;

  IF NOT legacy_table_exists THEN
    RETURN;
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'token_hash'
    ) THEN 'token_hash'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'password_reset_token_hash'
    ) THEN 'password_reset_token_hash'
    ELSE NULL
  END
    INTO token_hash_column;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'expires_at'
    ) THEN 'expires_at'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'password_reset_token_expires_at'
    ) THEN 'password_reset_token_expires_at'
    ELSE NULL
  END
    INTO expires_at_column;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'requested_at'
    ) THEN 'requested_at'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'created_at'
    ) THEN 'created_at'
    WHEN EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'password_reset_tokens'
        AND column_name = 'updated_at'
    ) THEN 'updated_at'
    ELSE NULL
  END
    INTO requested_at_column;

  order_by_column := COALESCE(requested_at_column, expires_at_column);

  IF token_hash_column IS NOT NULL
     AND expires_at_column IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'password_reset_tokens'
         AND column_name = 'user_id'
     ) THEN
    EXECUTE format(
      'WITH ranked_tokens AS (
         SELECT
           user_id,
           %1$I AS token_hash,
           %2$I AS expires_at,
           %3$s AS requested_at,
           ROW_NUMBER() OVER (
             PARTITION BY user_id
             ORDER BY %4$s DESC NULLS LAST
           ) AS rn
         FROM public.password_reset_tokens
       )
       UPDATE public.users AS u
       SET password_reset_token_hash = rt.token_hash,
           password_reset_token_expires_at = rt.expires_at,
           password_reset_requested_at = rt.requested_at
       FROM ranked_tokens AS rt
       WHERE u.id = rt.user_id
         AND rt.rn = 1',
      token_hash_column,
      expires_at_column,
      CASE
        WHEN requested_at_column IS NOT NULL
          THEN format('%I', requested_at_column)
        ELSE 'NULL::timestamp'
      END,
      CASE
        WHEN order_by_column IS NOT NULL
          THEN format('%I', order_by_column)
        ELSE 'user_id'
      END
    );
  END IF;

  DROP TABLE IF EXISTS public.password_reset_tokens;
END $$;
