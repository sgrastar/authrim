-- Allow a disabled resource projection to be re-owned by a later fenced provisioning operation.

DROP TRIGGER IF EXISTS trg_plugin_runner_dynamic_resource_identity_immutable;

CREATE TRIGGER trg_plugin_runner_dynamic_resource_identity_immutable
BEFORE UPDATE OF installation_id, tenant_id, plugin_id, logical_resource_id, logical_binding_name,
  host_binding_ref, resource_kind, access_mode, ownership_fingerprint
ON plugin_runner_dynamic_worker_resources
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_resource_identity_immutable');
END;

CREATE TRIGGER trg_plugin_runner_dynamic_resource_operation_fenced
BEFORE UPDATE OF control_operation_id
ON plugin_runner_dynamic_worker_resources
WHEN OLD.control_operation_id <> NEW.control_operation_id
  AND NOT (OLD.state = 'disabled' AND NEW.state = 'active')
BEGIN
  SELECT RAISE(ABORT, 'plugin_dynamic_resource_operation_fenced');
END;
