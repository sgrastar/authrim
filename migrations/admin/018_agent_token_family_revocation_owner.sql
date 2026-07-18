-- Repair the refresh-family revocation ownership column without changing the already-applied
-- 012 control-plane migration. Grant invalidation writes this locator in the same atomic batch as
-- the Grant generation change, consent revocation, outbox enqueue, and audit event.
ALTER TABLE admin_agent_token_families ADD COLUMN revocation_outbox_id TEXT;

CREATE INDEX IF NOT EXISTS idx_admin_agent_token_families_revocation_outbox
  ON admin_agent_token_families(tenant_id, revocation_outbox_id, family_id);
