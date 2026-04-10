ALTER TABLE users
  ADD COLUMN IF NOT EXISTS dashboard_tour_completed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dashboard_tour_completed_at TIMESTAMP;

UPDATE users
   SET dashboard_tour_completed = TRUE,
       dashboard_tour_completed_at = COALESCE(dashboard_tour_completed_at, CURRENT_TIMESTAMP)
 WHERE COALESCE(login_count, 0) > 0
   AND dashboard_tour_completed = FALSE;
