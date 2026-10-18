-- Whether a tenant lets the code of external (dynamic worker) plugins run. ar-plugin-runner cannot
-- read tenant settings, so ar-management projects the tenant's plugin.enabled here, and every
-- resolution of a dynamic_worker installation (hook targets, outbox execution, sync hooks, egress,
-- host interfaces) requires an open gate. No row means closed. generation only ever grows, one step
-- for each change of allowed.
CREATE TABLE IF NOT EXISTS plugin_runner_tenant_external_gates (
  tenant_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(tenant_id) BETWEEN 1 AND 256 AND tenant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 1)
);

-- The periodic reconciliation of the gates (ar-management) looks for tenants that have an enabled
-- external installation; this keeps that lookup off the built-in installations.
CREATE INDEX IF NOT EXISTS idx_plugin_runner_installations_enabled_external
  ON plugin_runner_installations (tenant_id)
  WHERE backend_kind = 'dynamic_worker' AND state = 'enabled';
