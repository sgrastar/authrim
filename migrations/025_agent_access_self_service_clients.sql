-- Phase 2D: lifecycle metadata for restricted Admin Agent self-service registrations.
ALTER TABLE oauth_clients ADD COLUMN agent_access_registration_mode TEXT
  CHECK (agent_access_registration_mode IS NULL OR agent_access_registration_mode IN ('restricted_dcr', 'cimd'));
ALTER TABLE oauth_clients ADD COLUMN agent_access_expires_at INTEGER;
ALTER TABLE oauth_clients ADD COLUMN agent_access_last_used_at INTEGER;
ALTER TABLE oauth_clients ADD COLUMN agent_access_registration_slot INTEGER
  CHECK (agent_access_registration_slot IS NULL OR
    (agent_access_registration_slot >= 0 AND agent_access_registration_slot < 20));
ALTER TABLE oauth_clients ADD COLUMN client_metadata_url TEXT;
ALTER TABLE oauth_clients ADD COLUMN client_metadata_hash TEXT;
ALTER TABLE oauth_clients ADD COLUMN client_metadata_fetched_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_oauth_clients_agent_access_lifecycle
  ON oauth_clients(tenant_id, agent_access_registration_mode, agent_access_expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_clients_agent_access_registration_slot
  ON oauth_clients(tenant_id, agent_access_registration_slot)
  WHERE agent_access_registration_mode = 'restricted_dcr'
    AND agent_access_registration_slot IS NOT NULL;
