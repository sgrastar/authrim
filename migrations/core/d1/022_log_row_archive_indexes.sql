-- The log row archiver reads a tenant's oldest rows in (event time, id) order. These tables had no
-- index starting with the tenant and the event time, so each batch would scan the whole table.
-- Each index adds one entry per inserted row.
CREATE INDEX IF NOT EXISTS idx_flow_audit_events_tenant_created
  ON flow_audit_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_provisioning_assignment_events_tenant_created
  ON provisioning_assignment_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_provisioning_revocation_events_tenant_created
  ON provisioning_revocation_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_service_group_audit_tenant_created
  ON service_group_audit(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_directory_auth_migration_tx_events_tenant_created
  ON directory_auth_migration_transaction_events(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_created
  ON audit_log(tenant_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_permission_change_audit_tenant_timestamp
  ON permission_change_audit(tenant_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_permission_check_audit_tenant_checked
  ON permission_check_audit(tenant_id, checked_at, id);
