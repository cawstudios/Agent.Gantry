-- Repair runtime_events schemas that have the post-0018 table shape but lost
-- the event_id identity/default during manual drift repair.
DO $$
DECLARE
  next_event_id bigint;
  has_identity boolean;
  has_default boolean;
BEGIN
  IF to_regclass('runtime_events') IS NULL THEN
    RETURN;
  END IF;

  SELECT
    a.attidentity <> '',
    d.adbin IS NOT NULL
  INTO has_identity, has_default
  FROM pg_attribute a
  LEFT JOIN pg_attrdef d
    ON d.adrelid = a.attrelid
   AND d.adnum = a.attnum
  WHERE a.attrelid = 'runtime_events'::regclass
    AND a.attname = 'event_id'
    AND NOT a.attisdropped;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF has_identity OR has_default THEN
    RETURN;
  END IF;

  EXECUTE 'SELECT COALESCE(MAX(event_id), 0) + 1 FROM runtime_events'
    INTO next_event_id;

  EXECUTE format(
    'ALTER TABLE runtime_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
    next_event_id
  );
END $$;
