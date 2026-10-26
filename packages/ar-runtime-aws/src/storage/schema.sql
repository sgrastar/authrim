-- Experimental AWS runtime bootstrap schema. The release migration stream is separate.
-- Apply before enabling the AWS SAML IdP runtime; do not apply to Cloudflare D1.
CREATE TABLE IF NOT EXISTS authrim_aws_transient_state (
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'challenge', 'saml_request', 'kv')),
  id TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  immutable_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(immutable_payload) = 'object'),
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT,
  revocation_bound_at_ms BIGINT,
  PRIMARY KEY (tenant_id, kind, id),
  CHECK (expires_at_ms > created_at_ms),
  CHECK ((kind = 'session' AND revocation_bound_at_ms IS NOT NULL)
      OR (kind <> 'session' AND revocation_bound_at_ms IS NULL)),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS authrim_aws_transient_state_expiry_idx
  ON authrim_aws_transient_state (expires_at_ms);
