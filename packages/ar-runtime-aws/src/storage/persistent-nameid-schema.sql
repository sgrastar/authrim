-- Experimental AWS bootstrap schema; apply to the isolated runtime database only.
-- Values must survive session expiry and Lambda restarts to preserve SAML NameID continuity.
CREATE TABLE IF NOT EXISTS authrim_aws_saml_persistent_nameids (
  tenant_id TEXT NOT NULL,
  registry_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms > 0),
  PRIMARY KEY (tenant_id, registry_key)
);
