-- Migration: 078_tenant_first_operational_indexes.sql
-- Description: Rebuild tenant-owned operational indexes with tenant_id as the leading column.

DROP INDEX IF EXISTS idx_ai_grants_active;
DROP INDEX IF EXISTS idx_ai_grants_client;
DROP INDEX IF EXISTS idx_ai_grants_principal;
DROP INDEX IF EXISTS idx_ciba_status;
DROP INDEX IF EXISTS idx_ciba_user;
DROP INDEX IF EXISTS idx_cih_user;
DROP INDEX IF EXISTS idx_consents_user;
DROP INDEX IF EXISTS idx_device_codes_client_id;
DROP INDEX IF EXISTS idx_device_codes_status;
DROP INDEX IF EXISTS idx_issued_credentials_status;
DROP INDEX IF EXISTS idx_issued_credentials_type;
DROP INDEX IF EXISTS idx_linked_identities_provider;
DROP INDEX IF EXISTS idx_linked_identities_provider_sub;
DROP INDEX IF EXISTS idx_linked_identities_user;
DROP INDEX IF EXISTS idx_passkeys_user;
DROP INDEX IF EXISTS idx_relationships_from;
DROP INDEX IF EXISTS idx_relationships_to;
DROP INDEX IF EXISTS idx_relationships_type;
DROP INDEX IF EXISTS idx_roles_name;
DROP INDEX IF EXISTS idx_roles_parent_role_id;
DROP INDEX IF EXISTS idx_password_reset_user;
DROP INDEX IF EXISTS idx_session_clients_session_id;
DROP INDEX IF EXISTS idx_sessions_user;
DROP INDEX IF EXISTS idx_token_families_client;
DROP INDEX IF EXISTS idx_token_families_user;

CREATE INDEX idx_ai_grants_active ON ai_grants(tenant_id, is_active);
CREATE INDEX idx_ai_grants_client ON ai_grants(tenant_id, client_id);
CREATE INDEX idx_ai_grants_principal ON ai_grants(tenant_id, ai_principal);
CREATE INDEX idx_ciba_status ON ciba_requests(tenant_id, status);
CREATE INDEX idx_ciba_user ON ciba_requests(tenant_id, user_id);
CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);
CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);
CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id);
CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status);
CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status);
CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type);
CREATE INDEX idx_linked_identities_provider ON linked_identities(tenant_id, provider_id);
CREATE INDEX idx_linked_identities_provider_sub
  ON linked_identities(tenant_id, provider_id, provider_user_id);
CREATE INDEX idx_linked_identities_user ON linked_identities(tenant_id, user_id);
CREATE INDEX idx_passkeys_user ON passkeys(tenant_id, user_id);
CREATE INDEX idx_relationships_from ON relationships(tenant_id, from_type, from_id);
CREATE INDEX idx_relationships_to ON relationships(tenant_id, to_type, to_id);
CREATE INDEX idx_relationships_type ON relationships(tenant_id, relationship_type);
CREATE INDEX idx_roles_name ON roles(tenant_id, name);
CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id);
CREATE INDEX idx_password_reset_user ON password_reset_tokens(tenant_id, user_id);
CREATE INDEX idx_session_clients_session_id ON session_clients(tenant_id, session_id);
CREATE INDEX idx_sessions_user ON sessions(tenant_id, user_id);
CREATE INDEX idx_token_families_client ON user_token_families(tenant_id, client_id);
CREATE INDEX idx_token_families_user ON user_token_families(tenant_id, user_id);
