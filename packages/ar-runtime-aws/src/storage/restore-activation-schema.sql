-- AWS-only import publication journal. Staging and failed imports cannot serve traffic.
CREATE TABLE IF NOT EXISTS authrim_aws_restore_activations (
  tenant_id TEXT PRIMARY KEY,
  restore_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'failed')),
  evidence_json TEXT,
  evidence_sha256 TEXT,
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms > 0),
  activated_at_ms BIGINT,
  CHECK ((status = 'active') = (activated_at_ms IS NOT NULL)),
  CHECK ((evidence_json IS NULL) = (evidence_sha256 IS NULL))
);
