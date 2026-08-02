DROP VIEW IF EXISTS control_desired_worker_binding_export;

CREATE TABLE control_worker_desired_bindings_v016 (
  environment_id TEXT NOT NULL,
  worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  binding_kind TEXT NOT NULL
    CHECK (binding_kind IN ('d1', 'kv_namespace', 'r2_bucket', 'service', 'dispatch_namespace',
      'worker_loader', 'durable_object_namespace', 'queue', 'send_email', 'hyperdrive',
      'version_metadata', 'secret', 'binding', 'plugin_interface')),
  data_role TEXT,
  logical_resource_id TEXT,
  secret_capability TEXT,
  plugin_dynamic_capability TEXT,
  desired_spec_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(desired_spec_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (environment_id, worker_script_name, binding_name),
  FOREIGN KEY (environment_id, worker_script_name)
    REFERENCES control_desired_worker_inventory(environment_id, worker_script_name) ON DELETE CASCADE,
  CHECK (data_role IS NULL OR data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup', 'control', 'plugin_runner')),
  CHECK ((binding_kind = 'secret' AND secret_capability IS NOT NULL
    AND data_role IS NULL AND logical_resource_id IS NULL) OR
    (binding_kind <> 'secret' AND secret_capability IS NULL))
);

INSERT INTO control_worker_desired_bindings_v016 (
  environment_id,
  worker_script_name,
  binding_name,
  binding_kind,
  data_role,
  logical_resource_id,
  secret_capability,
  plugin_dynamic_capability,
  desired_spec_json,
  updated_at
)
SELECT
  environment_id,
  worker_script_name,
  binding_name,
  binding_kind,
  data_role,
  logical_resource_id,
  secret_capability,
  plugin_dynamic_capability,
  desired_spec_json,
  updated_at
FROM control_worker_desired_bindings;

DROP TABLE control_worker_desired_bindings;
ALTER TABLE control_worker_desired_bindings_v016 RENAME TO control_worker_desired_bindings;

CREATE VIEW control_desired_worker_binding_export AS
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  b.binding_name,
  b.binding_kind,
  b.data_role,
  b.logical_resource_id,
  b.secret_capability,
  b.plugin_dynamic_capability,
  b.desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_desired_bindings b
  ON b.environment_id = i.environment_id AND b.worker_script_name = i.worker_script_name
WHERE i.status = 'active'
UNION ALL
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  s.binding_ref AS binding_name,
  'd1' AS binding_kind,
  r.data_role,
  s.d1_desired_resource_id AS logical_resource_id,
  NULL AS secret_capability,
  NULL AS plugin_dynamic_capability,
  json_object(
    'shard_id', s.shard_id,
    'residency_policy_id', s.residency_policy_id,
    'residency_partition', s.residency_partition,
    'generation', s.generation,
    'status', s.status
  ) AS desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_required_data_roles r
  ON r.environment_id = i.environment_id AND r.worker_script_name = i.worker_script_name
JOIN control_tenant_shards s
  ON s.environment_id = r.environment_id AND s.data_role = r.data_role
WHERE i.status = 'active'
  AND r.data_role IN ('tenant_core/default', 'tenant_core/users', 'tenant_pii')
  AND s.status NOT IN ('retired', 'deleting', 'deleted');
