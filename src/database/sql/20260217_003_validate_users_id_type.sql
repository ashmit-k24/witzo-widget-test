DO $$
DECLARE
  users_id_type TEXT;
BEGIN
  SELECT data_type
  INTO users_id_type
  FROM information_schema.columns
  WHERE table_name = 'users'
    AND column_name = 'id';

  IF users_id_type IS NOT NULL AND users_id_type <> 'uuid' THEN
    RAISE EXCEPTION 'Incompatible users.id type detected (%). This app requires UUID user IDs.', users_id_type;
  END IF;
END $$;

