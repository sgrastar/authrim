-- End-user groups and RBAC delegation. Memberships are stored on the subject shard.
CREATE TABLE "groups" (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_group_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, group_key)
);
CREATE INDEX idx_groups_tenant_state
  ON "groups"(tenant_id, lifecycle_state, display_name);
ALTER TABLE "groups" ADD COLUMN kind TEXT NOT NULL DEFAULT 'static'
  CHECK (kind IN ('static', 'dynamic', 'scim', 'provisioned'));
ALTER TABLE "groups" ADD COLUMN external_id TEXT;
ALTER TABLE "groups" ADD COLUMN rule_revision INTEGER CHECK (kind = 'dynamic' OR rule_revision IS NULL);
ALTER TABLE roles ADD COLUMN grant_tier INTEGER NOT NULL DEFAULT 1 CHECK (grant_tier >= 1);

CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  assignment_source TEXT NOT NULL CHECK (assignment_source IN ('manual', 'scim', 'rule', 'dynamic', 'invitation')),
  source_ref TEXT NOT NULL DEFAULT '',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  starts_at BIGINT,
  expires_at BIGINT,
  stale_after BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, assignment_source, source_ref)
);
CREATE INDEX idx_group_memberships_subject ON group_memberships(tenant_id, subject_id, lifecycle_state);
CREATE INDEX idx_group_memberships_group ON group_memberships(tenant_id, group_id, lifecycle_state);

CREATE TABLE group_role_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at BIGINT,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, group_id, role_id, scope_type, scope_target)
);
CREATE INDEX idx_group_roles_group ON group_role_assignments(tenant_id, group_id);
CREATE INDEX idx_group_roles_role ON group_role_assignments(tenant_id, role_id);

CREATE TABLE resource_permissions (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL DEFAULT 'user',
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  condition_json TEXT,
  expires_at BIGINT,
  is_active INTEGER DEFAULT 1,
  granted_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);
CREATE INDEX idx_rp_expires ON resource_permissions(expires_at);
CREATE INDEX idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
);
CREATE INDEX idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
);

CREATE TABLE check_api_keys (
    id TEXT PRIMARY KEY NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    allowed_operations TEXT DEFAULT '["check"]',
    rate_limit_tier TEXT DEFAULT 'moderate',
    is_active INTEGER DEFAULT 1,
    expires_at BIGINT,
    created_by TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);
CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id);
CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash);
CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);
CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);

CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  resource_types TEXT,
  actions TEXT,
  conditions TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_by TEXT,
  updated_at BIGINT NOT NULL,
  UNIQUE(tenant_id, name)
);
CREATE INDEX idx_policy_rules_priority ON policy_rules(tenant_id, priority DESC);
CREATE INDEX idx_policy_rules_tenant ON policy_rules(tenant_id, enabled);

CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  description TEXT,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active);
CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name);
CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type);
CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name);
