-- Service site attachment: one desired service binding on the router Worker per environment.
-- Control owns the Worker settings patch; the router only reads the binding at request time.
CREATE TABLE IF NOT EXISTS control_service_site_bindings (
  environment_id TEXT PRIMARY KEY NOT NULL,
  router_worker_script_name TEXT NOT NULL,
  binding_name TEXT NOT NULL,
  desired_state TEXT NOT NULL CHECK (desired_state IN ('attached', 'detached')),
  desired_worker_name TEXT,
  -- The Worker the router binding points at, as last verified in the provider settings.
  attached_worker_name TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  operation_id TEXT NOT NULL,
  requested_by_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'settings_patched', 'rollback_required', 'succeeded',
                     'rolled_back', 'blocked')),
  expected_source_version_id TEXT,
  previous_deployment_id TEXT,
  patch_result_version_id TEXT,
  patch_result_deployment_id TEXT,
  -- Settings that restore the router to its pre-change bindings (inherit entries only).
  previous_restore_settings_json TEXT
    CHECK (previous_restore_settings_json IS NULL OR json_valid(previous_restore_settings_json)),
  -- The binding the router had under binding_name before the change, if any.
  previous_binding_json TEXT
    CHECK (previous_binding_json IS NULL OR json_valid(previous_binding_json)),
  stabilization_not_before INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (environment_id) REFERENCES control_environments(environment_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, environment_id)
    REFERENCES control_operations(operation_id, environment_id),
  CHECK ((desired_state = 'attached' AND desired_worker_name IS NOT NULL) OR desired_state = 'detached'),
  CHECK ((state = 'succeeded' AND completed_at IS NOT NULL) OR state <> 'succeeded')
);

CREATE INDEX IF NOT EXISTS idx_control_service_site_bindings_due
  ON control_service_site_bindings(state, next_attempt_at, updated_at);
