-- AWS-only atomic rate-limit counters. Apply before serving Direct Auth requests.
CREATE TABLE IF NOT EXISTS authrim_aws_rate_limit_counters (
  scope_kind text NOT NULL CHECK (scope_kind IN ('tenant', 'global')),
  scope_id text NOT NULL,
  key_hash char(64) NOT NULL,
  request_count bigint NOT NULL CHECK (request_count >= 1),
  reset_at_s bigint NOT NULL CHECK (reset_at_s > 0),
  PRIMARY KEY (scope_kind, scope_id, key_hash)
);

CREATE INDEX IF NOT EXISTS authrim_aws_rate_limit_counters_reset_idx
  ON authrim_aws_rate_limit_counters (reset_at_s);
