ALTER TABLE tenant_provisioning_operations
  ADD COLUMN isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
  CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive'));

CREATE TRIGGER IF NOT EXISTS trg_tenant_provisioning_placement_policy_immutable
BEFORE UPDATE OF isolation_policy ON tenant_provisioning_operations
BEGIN
  SELECT RAISE(ABORT, 'tenant_provisioning_placement_policy_immutable');
END;
