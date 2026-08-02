-- Explicit dynamic-plugin uninstall cleanup. Runtime disable never enters this workflow.

PRAGMA foreign_keys = ON;

ALTER TABLE control_plugin_desired_resources
  ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 1
    CHECK (lifecycle_generation >= 1);

CREATE TABLE IF NOT EXISTS control_plugin_resource_cleanup_operations (
  operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  source_operation_id TEXT NOT NULL,
  lifecycle_generation INTEGER NOT NULL CHECK (lifecycle_generation >= 1),
  reason TEXT NOT NULL CHECK (reason IN ('uninstall', 'canceled_pre_activation')),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'removing_bindings', 'quarantined',
      'deleting_resources', 'verifying_absence', 'succeeded', 'blocked')),
  worker_script_name TEXT,
  binding_names_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(binding_names_json)),
  binding_presence_required INTEGER NOT NULL DEFAULT 0
    CHECK (binding_presence_required IN (0, 1)),
  expected_source_version_id TEXT,
  previous_deployment_id TEXT,
  previous_restore_settings_json TEXT
    CHECK (previous_restore_settings_json IS NULL OR json_valid(previous_restore_settings_json)),
  drain_not_before INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (environment_id, plugin_installation_id, lifecycle_generation),
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id) ON DELETE CASCADE,
  FOREIGN KEY (source_operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((state IN ('quarantined', 'deleting_resources', 'verifying_absence', 'succeeded')
          AND drain_not_before IS NOT NULL) OR
         state NOT IN ('quarantined', 'deleting_resources', 'verifying_absence', 'succeeded')),
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded'),
  CHECK (binding_presence_required = 0 OR worker_script_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_control_plugin_resource_cleanup_due
  ON control_plugin_resource_cleanup_operations(environment_id, state, drain_not_before, updated_at);

CREATE TABLE IF NOT EXISTS control_plugin_resource_cleanup_items (
  operation_id TEXT NOT NULL,
  plugin_resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('d1', 'kv_namespace', 'r2_bucket')),
  lifecycle_mode TEXT NOT NULL CHECK (lifecycle_mode IN ('managed', 'existing')),
  provider_resource_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  ownership_fingerprint TEXT NOT NULL
    CHECK (length(ownership_fingerprint) = 64 AND
           ownership_fingerprint NOT GLOB '*[^0-9a-f]*'),
  delete_provider_resource INTEGER NOT NULL CHECK (delete_provider_resource IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'quarantined', 'deleting', 'deleted', 'detached', 'blocked')),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (operation_id, plugin_resource_id),
  FOREIGN KEY (operation_id)
    REFERENCES control_plugin_resource_cleanup_operations(operation_id) ON DELETE CASCADE,
  CHECK ((lifecycle_mode = 'managed' AND delete_provider_resource = 1) OR
         (lifecycle_mode = 'existing' AND delete_provider_resource = 0)),
  CHECK ((state IN ('deleted', 'detached') AND completed_at IS NOT NULL) OR
         state NOT IN ('deleted', 'detached'))
);

CREATE TRIGGER IF NOT EXISTS trg_control_plugin_resource_cleanup_generation_match
BEFORE INSERT ON control_plugin_resource_cleanup_items
WHEN NOT EXISTS (
  SELECT 1
    FROM control_plugin_resource_cleanup_operations cleanup
    JOIN control_plugin_desired_resources resource
      ON resource.plugin_resource_id = NEW.plugin_resource_id
     AND resource.environment_id = cleanup.environment_id
     AND resource.plugin_installation_id = cleanup.plugin_installation_id
     AND resource.tenant_id = cleanup.tenant_id
     AND resource.lifecycle_generation = cleanup.lifecycle_generation
   WHERE cleanup.operation_id = NEW.operation_id
     AND resource.provider_resource_id = NEW.provider_resource_id
     AND resource.provider_name = NEW.provider_name
     AND resource.resource_kind = NEW.resource_kind
     AND resource.lifecycle_mode = NEW.lifecycle_mode
)
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_cleanup_resource_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_control_plugin_resource_cleanup_no_active_duplicate
BEFORE INSERT ON control_plugin_resource_cleanup_operations
WHEN EXISTS (
  SELECT 1 FROM control_plugin_resource_cleanup_operations cleanup
   WHERE cleanup.environment_id = NEW.environment_id
     AND cleanup.plugin_installation_id = NEW.plugin_installation_id
     AND cleanup.state <> 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'control_plugin_cleanup_already_active');
END;
