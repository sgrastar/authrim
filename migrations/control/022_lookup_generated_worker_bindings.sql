-- Keep every active physical Lookup shard in setup-generated Worker configuration.
-- The capability-owned LOOKUP_DB binding remains the bootstrap binding; additional
-- TDB_LOOKUP_* bindings are projected from Control-owned physical shard inventory.

DROP VIEW IF EXISTS control_desired_worker_binding_export;

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
  AND s.status NOT IN ('retired', 'deleting', 'deleted')
UNION ALL
SELECT
  i.environment_id,
  i.worker_script_name,
  i.package_name,
  i.capability_manifest_digest,
  l.binding_ref AS binding_name,
  'd1' AS binding_kind,
  r.data_role,
  l.d1_desired_resource_id AS logical_resource_id,
  NULL AS secret_capability,
  NULL AS plugin_dynamic_capability,
  json_object(
    'lookup_shard_id', l.lookup_shard_id,
    'residency_partition', l.residency_partition,
    'status', l.status
  ) AS desired_spec_json
FROM control_desired_worker_inventory i
JOIN control_worker_required_data_roles r
  ON r.environment_id = i.environment_id AND r.worker_script_name = i.worker_script_name
JOIN control_lookup_physical_shards l
  ON l.environment_id = r.environment_id
WHERE i.status = 'active'
  AND r.data_role = 'lookup'
  AND l.status <> 'retired'
  AND NOT EXISTS (
    SELECT 1
      FROM control_worker_desired_bindings b
     WHERE b.environment_id = i.environment_id
       AND b.worker_script_name = i.worker_script_name
       AND b.binding_name = l.binding_ref
  );
