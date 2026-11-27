-- End-user groups and RBAC delegation. Memberships are stored on the subject shard.
ALTER TABLE "groups" ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'
  CHECK (kind IN ('static', 'dynamic', 'scim', 'provisioned'));
ALTER TABLE "groups" ADD COLUMN external_id TEXT;
ALTER TABLE "groups" ADD COLUMN rule_revision INTEGER CHECK (kind = 'dynamic' OR rule_revision IS NULL);
ALTER TABLE roles ADD COLUMN grant_tier INTEGER NOT NULL DEFAULT 1 CHECK (grant_tier >= 1);

DROP TABLE group_memberships;

CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  assignment_source TEXT NOT NULL CHECK (assignment_source IN ('manual', 'scim', 'rule', 'dynamic', 'invitation')),
  source_ref TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  starts_at INTEGER,
  expires_at INTEGER,
  stale_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, assignment_source, source_ref)
);
CREATE INDEX idx_group_memberships_subject ON group_memberships(tenant_id, subject_id, lifecycle_state);
CREATE INDEX idx_group_memberships_group ON group_memberships(tenant_id, group_id, lifecycle_state);

CREATE TABLE group_role_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, role_id, scope_type, scope_target)
);
CREATE INDEX idx_group_roles_group ON group_role_assignments(tenant_id, group_id);
CREATE INDEX idx_group_roles_role ON group_role_assignments(tenant_id, role_id);
