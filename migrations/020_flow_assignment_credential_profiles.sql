-- =============================================================================
-- Authrim Core Migration 020: Credential Profile Flow Assignments
-- =============================================================================
-- Extend the immutable Flow runtime baseline with credential-profile targets.
-- SQLite cannot alter CHECK constraints in place, so rebuild the child table,
-- preserve all assignments, and recreate its indexes.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE flow_assignments_with_credential_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (
    target_type IN ('tenant', 'oidc_client', 'saml_sp', 'credential_profile')
  ),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp', 'credential_profile') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);

INSERT INTO flow_assignments_with_credential_profiles (
  id,
  tenant_id,
  target_type,
  target_id,
  flow_kind,
  flow_id,
  enabled,
  created_at,
  updated_at
)
SELECT
  id,
  tenant_id,
  target_type,
  target_id,
  flow_kind,
  flow_id,
  enabled,
  created_at,
  updated_at
FROM flow_assignments;

DROP TABLE flow_assignments;
ALTER TABLE flow_assignments_with_credential_profiles RENAME TO flow_assignments;

CREATE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, target_type, flow_kind, target_id);

CREATE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind);

CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);

CREATE UNIQUE INDEX idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, COALESCE(target_id, ''), flow_kind);

PRAGMA defer_foreign_keys = OFF;
