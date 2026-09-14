-- Non-secret export descriptors survive worker takeover independently of request memory.
CREATE TABLE tenant_backup_export_manifests (
  attempt_id TEXT NOT NULL PRIMARY KEY REFERENCES tenant_backup_artifact_attempts(id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB))<=262144),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE TRIGGER tenant_backup_export_manifest_immutable
BEFORE UPDATE ON tenant_backup_export_manifests
BEGIN SELECT RAISE(ABORT,'backup_export_manifest_immutable'); END;
