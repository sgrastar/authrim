ALTER TABLE linked_identities
  ADD COLUMN provisioning_state TEXT NOT NULL DEFAULT 'active'
  CHECK (provisioning_state IN ('pending', 'active'));

CREATE INDEX IF NOT EXISTS idx_linked_identities_provisioning
  ON linked_identities(tenant_id, provider_id, provider_user_id, provisioning_state);
