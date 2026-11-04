-- AWS-only one-time token jti records (replay protection). An expired row counts as absent,
-- so correctness never depends on pruning.
CREATE TABLE IF NOT EXISTS authrim_aws_replay_jtis (
  tenant_id text NOT NULL,
  key_hash char(64) NOT NULL,
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > 0),
  PRIMARY KEY (tenant_id, key_hash)
);

CREATE INDEX IF NOT EXISTS authrim_aws_replay_jtis_expires_idx
  ON authrim_aws_replay_jtis (expires_at_ms);
