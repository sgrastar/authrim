-- Tenant-scope scope mapping identity and related RBAC/org indexes.
-- Backward compatibility is intentionally not preserved during the tenant hardening pass.

PRAGMA foreign_keys=off;

CREATE TABLE scope_mappings_new (
  scope TEXT NOT NULL,
  claim_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_column TEXT NOT NULL,
  transformation TEXT,
  condition TEXT,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, claim_name)
);

INSERT INTO scope_mappings_new (
  scope,
  claim_name,
  source_table,
  source_column,
  transformation,
  condition,
  created_at,
  tenant_id
)
SELECT
  scope,
  claim_name,
  source_table,
  source_column,
  transformation,
  condition,
  created_at,
  tenant_id
FROM scope_mappings;

DROP TABLE scope_mappings;
ALTER TABLE scope_mappings_new RENAME TO scope_mappings;

DROP INDEX IF EXISTS idx_scope_mappings_scope;
CREATE INDEX idx_scope_mappings_scope ON scope_mappings(tenant_id, scope);

DROP INDEX IF EXISTS idx_membership_org;
DROP INDEX IF EXISTS idx_membership_subject;
CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id);
CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id);

DROP INDEX IF EXISTS idx_role_assignments_role;
DROP INDEX IF EXISTS idx_role_assignments_subject;
CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id);
CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id);

PRAGMA foreign_keys=on;
