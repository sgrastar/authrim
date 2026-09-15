-- Strongly consistent source for tenant/client SettingsManager documents.
-- Workers KV remains a runtime projection and is never the backup snapshot authority.
CREATE TABLE tenant_settings_documents (
  tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('tenant','client')),
  scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 128),
  category TEXT NOT NULL CHECK(length(category) BETWEEN 1 AND 128),
  document_json TEXT NOT NULL CHECK(
    json_valid(document_json) AND
    json_type(document_json)='object' AND
    length(CAST(document_json AS BLOB))<=1048576
  ),
  version TEXT NOT NULL CHECK(
    length(version)=23 AND
    version LIKE 'sha256:%' AND
    substr(version,8) NOT GLOB '*[^0-9a-f]*'
  ),
  revision INTEGER NOT NULL CHECK(revision>0),
  projection_state TEXT NOT NULL CHECK(projection_state IN ('pending','applied')),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  projected_at INTEGER CHECK(projected_at IS NULL OR projected_at>=updated_at),
  PRIMARY KEY(tenant_id,scope_type,scope_id,category),
  CHECK(scope_type='client' OR tenant_id=scope_id),
  CHECK((projection_state='pending' AND projected_at IS NULL) OR
    (projection_state='applied' AND projected_at IS NOT NULL))
) STRICT;

CREATE INDEX idx_tenant_settings_documents_projection
  ON tenant_settings_documents(projection_state,updated_at,tenant_id,scope_type,scope_id,category);
