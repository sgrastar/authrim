ALTER TABLE tenants
  ADD COLUMN isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
  CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive'));

-- Scope weakening is never an in-place tenant update. shared_pool -> tenant_exclusive is
-- committed only by the Control-owned online placement migration cutover.
CREATE TRIGGER IF NOT EXISTS trg_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON tenants
WHEN OLD.isolation_policy = 'tenant_exclusive' AND NEW.isolation_policy <> 'tenant_exclusive'
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_policy_scope_weakening');
END;
