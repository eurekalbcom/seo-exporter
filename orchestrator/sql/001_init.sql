-- Recommendations are proposed only. status cannot leave 'proposed'.
CREATE TABLE recommendations (
  id text PRIMARY KEY,
  domain text NOT NULL,
  category text NOT NULL CHECK (category IN ('gsc_bing_settings', 'site_change')),
  description text NOT NULL,
  rationale text NOT NULL,
  data jsonb NOT NULL,
  risk text NOT NULL,
  rollback text NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status = 'proposed'),
  score double precision NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only. UPDATE and DELETE are rejected by trigger.
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  action text NOT NULL,
  domain text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION audit_log_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_block_mutation();

CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW
EXECUTE FUNCTION audit_log_block_mutation();

-- TRUNCATE does not fire row DELETE triggers.
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT
EXECUTE FUNCTION audit_log_block_mutation();
