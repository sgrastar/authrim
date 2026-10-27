-- Experimental AWS bootstrap schema; apply to the isolated runtime database only.
CREATE TABLE IF NOT EXISTS authrim_aws_audit_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  action TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS authrim_aws_audit_events_time
  ON authrim_aws_audit_events (tenant_id, created_at_ms);
