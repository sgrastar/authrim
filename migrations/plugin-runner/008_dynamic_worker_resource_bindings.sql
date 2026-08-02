CREATE TABLE IF NOT EXISTS plugin_runner_dynamic_worker_resources (
  installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  logical_resource_id TEXT NOT NULL,
  logical_binding_name TEXT NOT NULL,
  host_binding_ref TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv_namespace', 'r2_bucket')),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('read_only', 'read_write')),
  ownership_fingerprint TEXT NOT NULL
    CHECK (length(ownership_fingerprint) = 64
      AND ownership_fingerprint NOT GLOB '*[^0-9a-f]*'),
  control_operation_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (installation_id, logical_resource_id),
  UNIQUE (host_binding_ref),
  UNIQUE (installation_id, logical_binding_name),
  CHECK (length(installation_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 128
    AND plugin_id GLOB '[a-z0-9]*' AND plugin_id NOT GLOB '*[^a-z0-9._-]*'),
  CHECK (length(logical_resource_id) BETWEEN 1 AND 128
    AND logical_resource_id GLOB '[a-z0-9]*'
    AND logical_resource_id NOT GLOB '*[^a-z0-9._-]*'),
  CHECK (length(logical_binding_name) BETWEEN 1 AND 128
    AND logical_binding_name GLOB '[A-Z]*'
    AND logical_binding_name NOT GLOB '*[^A-Z0-9_]*'),
  CHECK (length(host_binding_ref) = 32
    AND substr(host_binding_ref, 9) NOT GLOB '*[^A-F0-9]*'
    AND ((resource_kind = 'd1' AND host_binding_ref GLOB 'PRES_D1_*')
      OR (resource_kind = 'kv_namespace' AND host_binding_ref GLOB 'PRES_KV_*')
      OR (resource_kind = 'r2_bucket' AND host_binding_ref GLOB 'PRES_R2_*'))),
  CHECK (length(control_operation_id) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS idx_plugin_runner_dynamic_resource_active
  ON plugin_runner_dynamic_worker_resources(installation_id, tenant_id, state);

CREATE TRIGGER IF NOT EXISTS trg_plugin_runner_dynamic_resource_identity_immutable
BEFORE UPDATE OF installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
  host_binding_ref, resource_kind, access_mode, ownership_fingerprint, control_operation_id
ON plugin_runner_dynamic_worker_resources
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_resource_identity_immutable');
END;
