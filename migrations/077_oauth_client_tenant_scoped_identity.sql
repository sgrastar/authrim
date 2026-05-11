-- Migration: 077_oauth_client_tenant_scoped_identity.sql
-- Description: Allow the same OAuth client_id in different tenants.
--
-- This migration intentionally does not preserve data in the affected OAuth
-- client relationship tables. It is meant for the current pre-release schema
-- consolidation where backward compatibility is not required.

PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_oauth_clients_trust_group;
DROP INDEX IF EXISTS idx_oauth_clients_application_type;
DROP INDEX IF EXISTS idx_clients_claims_setting;
DROP INDEX IF EXISTS idx_clients_created_at;
DROP INDEX IF EXISTS idx_clients_software_id_tenant;
DROP INDEX IF EXISTS idx_clients_trusted;
DROP INDEX IF EXISTS idx_oauth_clients_tenant_id;
DROP INDEX IF EXISTS idx_ciba_client;
DROP INDEX IF EXISTS idx_ciba_status;
DROP INDEX IF EXISTS idx_ciba_user;
DROP INDEX IF EXISTS idx_cco_client;
DROP INDEX IF EXISTS idx_consents_client;
DROP INDEX IF EXISTS idx_consents_expires_at_active;
DROP INDEX IF EXISTS idx_consents_user;
DROP INDEX IF EXISTS idx_web_origin_registry_client;
DROP INDEX IF EXISTS idx_web_origin_registry_origin;
DROP INDEX IF EXISTS idx_session_clients_client_id;
DROP INDEX IF EXISTS idx_session_clients_last_seen_at;
DROP INDEX IF EXISTS idx_session_clients_session_id;

DROP TABLE IF EXISTS ciba_requests;
DROP TABLE IF EXISTS client_consent_overrides;
DROP TABLE IF EXISTS oauth_client_consents;
DROP TABLE IF EXISTS web_origin_registry;
DROP TABLE IF EXISTS session_clients;
DROP TABLE IF EXISTS oauth_clients;

CREATE TABLE oauth_clients (
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
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
  PRIMARY KEY (tenant_id, client_id)
);

CREATE INDEX idx_oauth_clients_trust_group ON oauth_clients(tenant_id, trust_group);
CREATE INDEX idx_oauth_clients_application_type ON oauth_clients(tenant_id, application_type);
CREATE INDEX idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);
CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);
CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);
CREATE INDEX idx_clients_trusted ON oauth_clients(is_trusted);
CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);

CREATE TABLE ciba_requests (
  auth_req_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  login_hint TEXT,
  login_hint_token TEXT,
  id_token_hint TEXT,
  binding_message TEXT,
  user_code TEXT,
  acr_values TEXT,
  requested_expiry INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('poll', 'ping', 'push')),
  client_notification_token TEXT,
  client_notification_endpoint TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  interval INTEGER NOT NULL DEFAULT 5,
  user_id TEXT,
  sub TEXT,
  nonce TEXT,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);

CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id);
CREATE INDEX idx_ciba_status ON ciba_requests(status);
CREATE INDEX idx_ciba_user ON ciba_requests(user_id);

CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'inherit',
  min_version TEXT,
  enforcement TEXT,
  conditional_rules_json TEXT,
  display_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, statement_id)
);

CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);

CREATE TABLE oauth_client_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  selected_scopes TEXT,
  privacy_policy_version TEXT,
  tos_version TEXT,
  consent_version INTEGER DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, client_id)
);

CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);
CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at);
CREATE INDEX idx_consents_user ON oauth_client_consents(user_id);

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, origin)
);

CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);
CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);

CREATE TABLE session_clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  first_token_at INTEGER NOT NULL,
  last_token_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, session_id, client_id)
);

CREATE INDEX idx_session_clients_client_id ON session_clients(tenant_id, client_id);
CREATE INDEX idx_session_clients_last_seen_at ON session_clients(last_seen_at);
CREATE INDEX idx_session_clients_session_id ON session_clients(session_id);

PRAGMA foreign_keys = ON;
