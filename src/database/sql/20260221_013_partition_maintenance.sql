-- Migration: 20260221_013_partition_maintenance
--
-- Creates a reusable function that ensures the next 3 calendar months of
-- chat_messages partitions always exist, then optionally schedules it with
-- pg_cron if the extension is available.
--
-- The Node.js maintenanceWorker runs the same logic on startup and every 24 h,
-- so this migration is an optional belt-and-suspenders layer for environments
-- where pg_cron is enabled.

-- ─── Partition helper function ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ensure_chat_message_partitions()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  i            INTEGER;
  target_start DATE;
  target_end   DATE;
  table_name   TEXT;
BEGIN
  -- Always keep the current month plus the next 2 months created
  FOR i IN 0..2 LOOP
    target_start := date_trunc('month', CURRENT_DATE + (i || ' month')::INTERVAL)::date;
    target_end   := date_trunc('month', CURRENT_DATE + ((i + 1) || ' month')::INTERVAL)::date;
    table_name   := 'chat_messages_' || to_char(target_start, 'YYYYMM');

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF chat_messages FOR VALUES FROM (%L) TO (%L)',
      table_name,
      target_start::text,
      target_end::text
    );
  END LOOP;
END;
$$;

-- Run immediately so the current migration also backfills any missing partitions
SELECT ensure_chat_message_partitions();

-- ─── pg_cron schedule (only if extension is available) ───────────────────────
--
-- pg_cron must be in shared_preload_libraries and the extension must be
-- installed.  The DO block is wrapped in an exception handler so the migration
-- succeeds even on instances without pg_cron (e.g. local dev, managed Postgres
-- tiers that do not expose it).

DO $$
BEGIN
  -- Check whether pg_cron is installed before trying to schedule
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Remove any existing schedule with the same name to keep this idempotent
    PERFORM cron.unschedule('ensure-chat-partitions')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'ensure-chat-partitions'
    );

    -- Run on the 20th of every month at 00:05 UTC — well before the new month
    PERFORM cron.schedule(
      'ensure-chat-partitions',
      '5 0 20 * *',
      'SELECT ensure_chat_message_partitions()'
    );

    RAISE NOTICE 'pg_cron schedule "ensure-chat-partitions" created.';
  ELSE
    RAISE NOTICE 'pg_cron extension not found — partition creation is handled by the Node.js maintenanceWorker instead.';
  END IF;
END $$;

-- ─── widget_analytics cleanup function ───────────────────────────────────────

CREATE OR REPLACE FUNCTION cleanup_old_widget_analytics(retention_days INTEGER DEFAULT 90)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM widget_analytics
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Optionally schedule analytics cleanup via pg_cron as well
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    PERFORM cron.unschedule('cleanup-widget-analytics')
    WHERE EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'cleanup-widget-analytics'
    );

    -- Run every Sunday at 02:00 UTC
    PERFORM cron.schedule(
      'cleanup-widget-analytics',
      '0 2 * * 0',
      'SELECT cleanup_old_widget_analytics(90)'
    );

    RAISE NOTICE 'pg_cron schedule "cleanup-widget-analytics" created.';
  END IF;
END $$;
