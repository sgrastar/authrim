-- Narrow source-export delegation. Credentials and grants are operational state, never portable data.
CREATE TABLE tenant_backup_replication_grants (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL UNIQUE CHECK(length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^0-9a-f]*'),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json) AND length(CAST(scope_json AS BLOB))<=8192),
  scope_sha256 TEXT NOT NULL CHECK(length(scope_sha256)=64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  expires_at INTEGER NOT NULL CHECK(expires_at>created_at AND expires_at-created_at<=2592000000),
  creation_audit_id TEXT NOT NULL,
  revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at),
  revoked_by TEXT,
  revocation_audit_id TEXT,
  UNIQUE(id,tenant_id),
  CHECK((revoked_at IS NULL AND revoked_by IS NULL AND revocation_audit_id IS NULL) OR
    (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revocation_audit_id IS NOT NULL))
);
CREATE INDEX idx_tenant_backup_replication_grants_tenant ON tenant_backup_replication_grants(tenant_id,created_at,id);
CREATE TRIGGER tenant_backup_replication_grant_immutable
BEFORE UPDATE ON tenant_backup_replication_grants
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.created_by IS NOT OLD.created_by
  OR NEW.credential_sha256 IS NOT OLD.credential_sha256 OR NEW.scope_json IS NOT OLD.scope_json
  OR NEW.scope_sha256 IS NOT OLD.scope_sha256 OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at OR NEW.creation_audit_id IS NOT OLD.creation_audit_id
  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS NOT OLD.revoked_at
    OR NEW.revoked_by IS NOT OLD.revoked_by OR NEW.revocation_audit_id IS NOT OLD.revocation_audit_id))
BEGIN SELECT RAISE(ABORT,'backup_replication_grant_immutable'); END;
