-- Bring the Core PostgreSQL configuration used by SAML and browser passkey sign-in
-- into line with the current Core D1 schema. Integer switches intentionally remain
-- integers because the shared client and origin readers compare them with 1.
CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default'
);

CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);
-- The nested CASE makes invalid JSON behave like the D1 partial index: it has no
-- indexed entity ID. A plain jsonb cast in the predicate can fail during index build.
CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers (
    tenant_id,
    provider_type,
    (CASE
      WHEN config_json IS JSON THEN
        CASE
          WHEN jsonb_typeof(config_json::jsonb -> 'entityId') = 'string'
            THEN config_json::jsonb ->> 'entityId'
        END
    END)
  )
  WHERE provider_type IN ('saml_idp', 'saml_sp');

CREATE TABLE oauth_clients (
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  description TEXT,
  redirect_uris TEXT NOT NULL,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  logo_uri TEXT,
  client_uri TEXT,
  policy_uri TEXT,
  tos_uri TEXT,
  contacts TEXT,
  subject_type TEXT DEFAULT 'public',
  sector_identifier_uri TEXT,
  token_endpoint_auth_method TEXT DEFAULT 'client_secret_basic',
  token_exchange_allowed INTEGER DEFAULT 0,
  allowed_subject_token_clients TEXT,
  allowed_token_exchange_resources TEXT,
  delegation_mode TEXT DEFAULT 'delegation',
  client_credentials_allowed INTEGER DEFAULT 0,
  allowed_scopes TEXT,
  default_scope TEXT,
  default_audience TEXT,
  default_resource TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  is_trusted INTEGER DEFAULT 0,
  skip_consent INTEGER DEFAULT 0,
  allow_claims_without_scope INTEGER DEFAULT 0,
  claims_parameter_policy TEXT,
  asc_enabled INTEGER DEFAULT 1,
  asc_protected_request_required INTEGER DEFAULT 1,
  asc_sao_enabled INTEGER DEFAULT 1,
  asc_transformed_claims_enabled INTEGER DEFAULT 1,
  asc_allowed_transformed_claims TEXT,
  backchannel_token_delivery_mode TEXT,
  backchannel_client_notification_endpoint TEXT,
  backchannel_authentication_request_signing_alg TEXT,
  backchannel_user_code_parameter INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  jwks TEXT,
  jwks_uri TEXT,
  userinfo_signed_response_alg TEXT,
  post_logout_redirect_uris TEXT,
  allowed_redirect_origins TEXT,
  backchannel_logout_uri TEXT,
  backchannel_logout_session_required INTEGER DEFAULT 0,
  frontchannel_logout_uri TEXT,
  frontchannel_logout_session_required INTEGER DEFAULT 0,
  logout_webhook_uri TEXT,
  logout_webhook_secret_encrypted TEXT,
  registration_access_token_hash TEXT,
  initiate_login_uri TEXT,
  login_ui_url TEXT,
  id_token_signed_response_alg TEXT,
  request_object_signing_alg TEXT,
  client_secret_hash TEXT,
  software_id TEXT,
  software_version TEXT,
  requestable_scopes TEXT,
  require_pkce INTEGER DEFAULT 0,
  application_type TEXT DEFAULT 'web',
  trust_group TEXT,
  trust_group_id TEXT,
  browser_public_client_mode TEXT,
  browser_refresh_token_policy TEXT NOT NULL DEFAULT 'disabled',
  native_sso_enabled INTEGER,
  native_channel_allowed INTEGER,
  allowed_channels TEXT,
  device_secret_revoke_enabled INTEGER,
  device_secret_revoke_trust_groups TEXT,
  device_secret_introspection_enabled INTEGER,
  device_secret_introspection_trust_groups TEXT,
  identity_mapping TEXT,
  attribute_release_consent TEXT,
  authorization_signed_response_alg TEXT,
  authorization_encrypted_response_alg TEXT,
  authorization_encrypted_response_enc TEXT,
  token_endpoint_auth_signing_alg TEXT,
  agent_access_registration_mode TEXT
    CHECK (agent_access_registration_mode IS NULL OR
      agent_access_registration_mode IN ('restricted_dcr', 'cimd')),
  agent_access_expires_at BIGINT,
  agent_access_last_used_at BIGINT,
  agent_access_registration_slot INTEGER
    CHECK (agent_access_registration_slot IS NULL OR
      (agent_access_registration_slot >= 0 AND agent_access_registration_slot < 20)),
  client_metadata_url TEXT,
  client_metadata_hash TEXT,
  client_metadata_fetched_at BIGINT,
  tls_client_certificate_bound_access_tokens INTEGER NOT NULL DEFAULT 0,
  minimum_ial TEXT CHECK (minimum_ial IS NULL OR minimum_ial IN ('IAL1', 'IAL2', 'IAL3')),
  PRIMARY KEY (tenant_id, client_id)
);

CREATE INDEX idx_oauth_clients_trust_group ON oauth_clients(tenant_id, trust_group);
CREATE INDEX idx_oauth_clients_application_type ON oauth_clients(tenant_id, application_type);
CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);
CREATE INDEX idx_oauth_clients_agent_access_lifecycle
  ON oauth_clients(tenant_id, agent_access_registration_mode, agent_access_expires_at);
CREATE UNIQUE INDEX idx_oauth_clients_agent_access_registration_slot
  ON oauth_clients(tenant_id, agent_access_registration_slot)
  WHERE agent_access_registration_mode = 'restricted_dcr'
    AND agent_access_registration_slot IS NOT NULL;

CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  cors_allowed INTEGER NOT NULL DEFAULT 1,
  csp_frame_ancestors TEXT,
  handoff_allowed INTEGER NOT NULL DEFAULT 1,
  iframe_allowed INTEGER NOT NULL DEFAULT 0,
  environment TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
);

CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);
CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);

-- Existing PostgreSQL accounts cannot be assigned a route generation without
-- trusted source evidence. The importer must provide it for every restored row.
ALTER TABLE identity_accounts
  ADD COLUMN account_route_generation BIGINT
    CHECK (account_route_generation >= 1);
