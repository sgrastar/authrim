-- Authrim 0.5.0 semantic fresh-install baseline.
-- Logical stream: core-d1.
-- Generated from the final database state; do not append historical migration SQL here.
-- Fresh-install baselines must never be applied to upgrade an existing database.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS "flows" (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  graph_definition TEXT NOT NULL,
  compiled_plan TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
, slug TEXT, display_name TEXT, kind TEXT NOT NULL DEFAULT 'login', status TEXT NOT NULL DEFAULT 'draft', draft_editor_json TEXT, draft_runtime_base_json TEXT, published_version_id TEXT, deleted_at INTEGER, template_id TEXT);
INSERT INTO flows VALUES('flow-default-login-no-consent','default',NULL,'human-basic','Authentication-only Login',NULL,'{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','1.0.0',1,0,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'default-login-no-consent','Authentication-only Login','login','published','{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','flow-version-default-login-no-consent-v1',NULL,'default-login-no-consent');
INSERT INTO flows VALUES('flow-default-registration-no-consent','default',NULL,'human-basic','Registration (No consent)',NULL,'{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}','1.0.0',1,0,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'default-registration-no-consent','Registration (No consent)','registration','published','{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}','flow-version-default-registration-no-consent-v1',NULL,'default-registration-no-consent');
INSERT INTO flows VALUES('flow-saml-sp-oidc-rp','default',NULL,'human-basic','SAML SP/OIDC RP Flow','No-consent login Flow that branches to SAML or OIDC completion after authentication.','{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','1.0.0',1,0,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'system',__AUTHRIM_NOW_EPOCH_SECONDS__,'saml-sp-oidc-rp','SAML SP/OIDC RP Flow','login','published','{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','flow-version-saml-sp-oidc-rp-v1',NULL,'saml-sp-oidc-rp');
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
  -- RFC 8693: Token Exchange settings
  token_exchange_allowed INTEGER DEFAULT 0,
  allowed_subject_token_clients TEXT,  -- JSON array of client IDs
  allowed_token_exchange_resources TEXT,  -- JSON array of resource URIs
  delegation_mode TEXT DEFAULT 'delegation',  -- 'none' | 'delegation' | 'impersonation'
  -- RFC 6749 Section 4.4: Client Credentials settings
  client_credentials_allowed INTEGER DEFAULT 0,
  allowed_scopes TEXT,  -- JSON array of allowed scopes
  default_scope TEXT,  -- Default scope for Client Credentials
  default_audience TEXT,  -- Default audience for Client Credentials
  default_resource TEXT,  -- Default resource target for access tokens
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, is_trusted INTEGER DEFAULT 0, skip_consent INTEGER DEFAULT 0, allow_claims_without_scope INTEGER DEFAULT 0, claims_parameter_policy TEXT, asc_enabled INTEGER DEFAULT 1, asc_protected_request_required INTEGER DEFAULT 1, asc_sao_enabled INTEGER DEFAULT 1, asc_transformed_claims_enabled INTEGER DEFAULT 1, asc_allowed_transformed_claims TEXT, backchannel_token_delivery_mode TEXT, backchannel_client_notification_endpoint TEXT, backchannel_authentication_request_signing_alg TEXT, backchannel_user_code_parameter INTEGER DEFAULT 0, tenant_id TEXT NOT NULL DEFAULT 'default', jwks TEXT, jwks_uri TEXT, userinfo_signed_response_alg TEXT, post_logout_redirect_uris TEXT, allowed_redirect_origins TEXT, backchannel_logout_uri TEXT, backchannel_logout_session_required INTEGER DEFAULT 0, frontchannel_logout_uri TEXT, frontchannel_logout_session_required INTEGER DEFAULT 0, logout_webhook_uri TEXT, logout_webhook_secret_encrypted TEXT, registration_access_token_hash TEXT, initiate_login_uri TEXT, login_ui_url TEXT, id_token_signed_response_alg TEXT, request_object_signing_alg TEXT, client_secret_hash TEXT, software_id TEXT, software_version TEXT, requestable_scopes TEXT, require_pkce INTEGER DEFAULT 0, application_type TEXT DEFAULT 'web', trust_group TEXT, trust_group_id TEXT, browser_public_client_mode TEXT, browser_refresh_token_policy TEXT NOT NULL DEFAULT 'disabled', native_sso_enabled INTEGER, native_channel_allowed INTEGER, allowed_channels TEXT, device_secret_revoke_enabled INTEGER, device_secret_revoke_trust_groups TEXT, device_secret_introspection_enabled INTEGER, device_secret_introspection_trust_groups TEXT, identity_mapping TEXT, attribute_release_consent TEXT, authorization_signed_response_alg TEXT, authorization_encrypted_response_alg TEXT, authorization_encrypted_response_enc TEXT, token_endpoint_auth_signing_alg TEXT, agent_access_registration_mode TEXT
  CHECK (agent_access_registration_mode IS NULL OR agent_access_registration_mode IN ('restricted_dcr', 'cimd')), agent_access_expires_at INTEGER, agent_access_last_used_at INTEGER, agent_access_registration_slot INTEGER
  CHECK (agent_access_registration_slot IS NULL OR
    (agent_access_registration_slot >= 0 AND agent_access_registration_slot < 20)), client_metadata_url TEXT, client_metadata_hash TEXT, client_metadata_fetched_at INTEGER, tls_client_certificate_bound_access_tokens INTEGER NOT NULL DEFAULT 0, minimum_ial TEXT
  CHECK (minimum_ial IS NULL OR minimum_ial IN ('IAL1', 'IAL2', 'IAL3')), PRIMARY KEY (tenant_id, client_id));
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Rule configuration
  priority INTEGER NOT NULL DEFAULT 100,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),

  -- Target matching (JSON arrays)
  resource_types TEXT, -- JSON array of resource types to match
  actions TEXT,        -- JSON array of actions to match

  -- Conditions (JSON array of PolicyCondition objects)
  conditions TEXT NOT NULL DEFAULT '[]',

  -- Status
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Audit
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL,

  -- Indexes
  UNIQUE(tenant_id, name)
);
CREATE TABLE policy_simulations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,

  -- Simulation input (JSON)
  context TEXT NOT NULL,

  -- Simulation result
  allowed INTEGER NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT,

  -- Details (JSON)
  details TEXT,
  matched_rules TEXT, -- JSON array of rule IDs that were evaluated

  -- Audit
  simulated_by TEXT,
  simulated_at INTEGER NOT NULL
);
CREATE TABLE scope_mappings (
  scope TEXT NOT NULL,
  claim_name TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_column TEXT NOT NULL,
  transformation TEXT,
  condition TEXT,
  created_at INTEGER NOT NULL, tenant_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, claim_name)
);
CREATE TABLE profile_registry (
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage', 'audit', 'residency')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (kind, id)
);
CREATE TABLE IF NOT EXISTS "user_custom_fields" (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable INTEGER DEFAULT 1,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, user_id, field_name)
);
CREATE TABLE log_chunk_record_index (
  record_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_catalog_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  line_number INTEGER,
  block_offset INTEGER,
  block_length INTEGER,
  record_offset INTEGER,
  record_length INTEGER,
  event_at INTEGER NOT NULL,
  index_profile TEXT NOT NULL,
  indexed_fields TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'deleted')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_key, log_type, plane, record_id)
);
CREATE TABLE plugin_account_metadata_mutations (
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-z0-9._-]*' AND
      length(fingerprint_key_id) BETWEEN 1 AND 64),
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  request_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  data_role TEXT NOT NULL CHECK (data_role = 'tenant_core/users'),
  residency_partition TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plugin_installation_id, operation_id),
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK (length(request_id) BETWEEN 1 AND 256),
  CHECK (length(capability) BETWEEN 1 AND 128),
  CHECK (length(residency_partition) BETWEEN 1 AND 64)
);
CREATE TABLE plugin_account_metadata_audit (
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  result_version INTEGER NOT NULL CHECK (result_version >= 1),
  actor_type TEXT NOT NULL CHECK (actor_type = 'plugin'),
  request_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  mutation_scope TEXT NOT NULL CHECK (mutation_scope = 'account.metadata.write'),
  data_role TEXT NOT NULL CHECK (data_role = 'tenant_core/users'),
  residency_partition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, plugin_installation_id, operation_id),
  FOREIGN KEY (tenant_id, plugin_installation_id, operation_id)
    REFERENCES plugin_account_metadata_mutations(
      tenant_id, plugin_installation_id, operation_id
    ) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS "authrim_control_plane_shard_metadata" (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  binding_ref TEXT NOT NULL CHECK (
    binding_ref GLOB '[A-Z][A-Z0-9_]*_TDB_[A-Z0-9_]*'
  ),
  data_role TEXT NOT NULL
    CHECK (data_role IN ('tenant_core/default', 'tenant_core/users')),
  residency_partition TEXT NOT NULL
    CHECK (length(residency_partition) BETWEEN 1 AND 63),
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
  manifest_digest TEXT NOT NULL
    CHECK (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  expected_file_count INTEGER NOT NULL CHECK (expected_file_count >= 1),
  last_filename TEXT NOT NULL CHECK (length(last_filename) BETWEEN 1 AND 255),
  updated_at INTEGER NOT NULL
);
CREATE TABLE account_legal_hold_states (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  active_hold_id TEXT,
  projection_state TEXT NOT NULL DEFAULT 'inactive'
    CHECK (projection_state IN ('active', 'inactive')),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  CHECK ((projection_state = 'active' AND active_hold_id IS NOT NULL) OR
         (projection_state = 'inactive' AND active_hold_id IS NULL))
);
CREATE TABLE application_launchers (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE launcher_favorites (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  launcher_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, launcher_id)
);
CREATE TABLE guest_account_lifecycle (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'active'
    CHECK (phase IN ('active', 'upgrading', 'registered', 'deleting', 'deleted')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  deletion_due_at INTEGER,
  policy_version TEXT NOT NULL,
  retention_application_id TEXT,
  upgrade_hold_until INTEGER,
  upgrade_operation_id TEXT,
  upgrade_admission_floor INTEGER NOT NULL DEFAULT 0,
  upgraded_at INTEGER,
  upgrade_finalized_at INTEGER,
  deletion_operation_id TEXT,
  deletion_route_json TEXT,
  deletion_started_at_ms INTEGER,
  deleted_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id),
  CHECK (deletion_due_at IS NULL OR deletion_due_at >= created_at),
  CHECK (upgrade_hold_until IS NULL OR upgrade_hold_until >= created_at)
);
CREATE TABLE service_group_inputs (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_revisions (
 tenant_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_json TEXT NOT NULL,
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, revision)
);
CREATE TABLE service_group_manual (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, group_id TEXT NOT NULL,
 PRIMARY KEY (tenant_id, user_id, group_id)
);
CREATE TABLE service_group_results (
 tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
 rule_version INTEGER NOT NULL DEFAULT 0, core_version INTEGER NOT NULL DEFAULT -1,
 pii_version INTEGER NOT NULL DEFAULT -1, metadata_version INTEGER NOT NULL DEFAULT -1,
 epoch INTEGER NOT NULL DEFAULT -1, result_json TEXT, route_version TEXT NOT NULL DEFAULT '', evaluated_at INTEGER,
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, attempts INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE service_group_scans (
 tenant_id TEXT NOT NULL, binding_ref TEXT NOT NULL, rule_version INTEGER NOT NULL,
 cursor_id TEXT NOT NULL DEFAULT '', processed INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 PRIMARY KEY (tenant_id, binding_ref)
);
CREATE TABLE access_review_items (
  id TEXT PRIMARY KEY
 NOT NULL
,
  review_id TEXT NOT NULL REFERENCES access_reviews(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,        -- User being reviewed
  permission_type TEXT NOT NULL, -- role, permission, group_membership
  permission_value TEXT NOT NULL, -- The specific permission/role/group
  decision TEXT,                -- approved, revoked, pending
  decided_by TEXT,              -- Reviewer who made decision
  decided_at TEXT,              -- When decision was made
  justification TEXT,           -- Reason for decision
  created_at TEXT NOT NULL
, store_ref TEXT, entitlement_ref TEXT, apply_status TEXT
  CHECK (
    apply_status IS NULL
    OR apply_status IN ('applying', 'applied', 'incomplete', 'failed', 'skipped')
  ), apply_claimed_at TEXT, apply_first_at TEXT, apply_attempts INTEGER NOT NULL DEFAULT 0, applied_at TEXT, apply_error TEXT);
CREATE TABLE access_reviews (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,           -- Review campaign name
  description TEXT,             -- Campaign description
  scope TEXT NOT NULL,          -- all_users, role, organization, application
  scope_value TEXT,             -- Value for scope (role_id, org_id, client_id)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, in_progress, completed, cancelled
  reviewer_id TEXT,             -- User assigned to review
  total_items INTEGER NOT NULL DEFAULT 0,     -- Total items to review
  reviewed_items INTEGER NOT NULL DEFAULT 0,  -- Items reviewed
  approved_items INTEGER NOT NULL DEFAULT 0,  -- Items approved (access retained)
  revoked_items INTEGER NOT NULL DEFAULT 0,   -- Items revoked (access removed)
  created_at TEXT NOT NULL,
  started_at TEXT,              -- When review started
  completed_at TEXT,            -- When review completed
  due_date TEXT                 -- Review deadline
, created_by TEXT, completed_by TEXT, inactive_days INTEGER
  CHECK (inactive_days IS NULL OR (inactive_days >= 1 AND inactive_days <= 3650)));
CREATE TABLE account_creation_operations (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  allocation_idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN (
      'preparing', 'reserved', 'writing', 'directory_pending',
      'succeeded', 'blocked', 'canceled'
    )),
  publication_json TEXT
    CHECK (publication_json IS NULL OR
      (json_valid(publication_json) AND length(publication_json) <= 16384)),
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, actor_id, idempotency_key),
  UNIQUE (tenant_id, account_id),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded')
);
CREATE TABLE IF NOT EXISTS "account_lifecycle_event_outbox" (
  event_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type = 'account.created'),
  event_version INTEGER NOT NULL DEFAULT 1 CHECK (event_version = 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 4096),
  plugin_targets_json TEXT
    CHECK (plugin_targets_json IS NULL OR
      (json_valid(plugin_targets_json) AND length(plugin_targets_json) <= 4096)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'leased', 'retry', 'succeeded', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, operation_id, event_type),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK ((status = 'retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL) OR
         status <> 'retry'),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR status <> 'succeeded')
);
CREATE TABLE account_routing_outbox (
  outbox_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_kind TEXT NOT NULL
    CHECK (event_kind IN ('account_created', 'identifier_added', 'identifier_replaced', 'identifier_removed', 'account_disabled', 'account_deleted')),
  route_generation INTEGER NOT NULL CHECK (route_generation >= 1),
  route_schema_version INTEGER NOT NULL CHECK (route_schema_version >= 1),
  hmac_key_generation INTEGER NOT NULL CHECK (hmac_key_generation >= 1),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'pending', 'leased', 'retry', 'succeeded', 'blocked', 'dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);
CREATE TABLE account_support_contexts (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{"schema_version":1}'
    CHECK (json_valid(context_json) AND json_type(context_json) = 'object' AND
           length(context_json) BETWEEN 20 AND 32768),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(account_id) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);
CREATE TABLE account_webhook_outbox (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  registration_state TEXT NOT NULL CHECK (registration_state IN ('guest', 'registered')),
  previous_registration_state TEXT,
  changed_field TEXT,
  occurred_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  delivered_at BIGINT
);
CREATE TABLE admin_jobs (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL,

  -- Job type (e.g., 'users/import', 'users/bulk-update', 'reports/generate')
  job_type TEXT NOT NULL,

  -- Job status (pending, processing, completed, failed, partial_failure)
  status TEXT NOT NULL DEFAULT 'pending',

  -- Progress tracking (JSON)
  -- { "total": 100, "processed": 45, "succeeded": 43, "failed": 2 }
  progress TEXT,

  -- Job configuration (JSON)
  -- Input parameters for the job
  config TEXT,

  -- R2 key for input file (for import jobs)
  input_r2_key TEXT,

  -- R2 key for result file (for completed jobs with large results)
  result_r2_key TEXT,
  object_catalog_id TEXT,

  -- Result summary (JSON, for completed jobs)
  -- { "summary": {...}, "failures": [...] }
  result TEXT,

  -- Error information (for failed jobs)
  error_code TEXT,
  error_message TEXT,

  -- Actor who created the job
  created_by TEXT NOT NULL,

  -- Timestamps (Unix timestamp in seconds)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,

  -- Estimated completion time
  estimated_completion INTEGER,

  -- Generic job runner retry/dead-letter state
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at INTEGER,
  dead_lettered_at INTEGER
);
CREATE TABLE assurance_evidence (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  binding_id TEXT,
  evidence_type TEXT NOT NULL,
  issuer_ref TEXT,
  assurance_framework TEXT,
  assurance_level TEXT,
  evidence_hash TEXT,
  evidence_storage_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, revoked_by TEXT);
CREATE TABLE attribute_release_consents (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  destination_type TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  attribute_set_hash TEXT NOT NULL,
  consent_mode TEXT NOT NULL,
  consent_state TEXT NOT NULL DEFAULT 'granted',
  consent_record_id TEXT,
  first_granted_at INTEGER,
  last_confirmed_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, subject_id, destination_type, destination_id, attribute_set_hash)
);
CREATE TABLE attribute_verifications (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vp_request_id TEXT REFERENCES vp_requests(id),
    -- Issuer DID
    issuer_did TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verification result: 'verified' | 'failed' | 'expired'
    verification_result TEXT NOT NULL,
    -- Individual verification flags
    holder_binding_verified INTEGER DEFAULT 0,
    issuer_trusted INTEGER DEFAULT 0,
    status_valid INTEGER DEFAULT 0,
    -- JSON array of user_verified_attributes IDs
    mapped_attribute_ids TEXT,
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT
, credential_profile_id TEXT, credential_profile_version_id TEXT, mapping_version_id TEXT, mapping_snapshot_hash TEXT, policy_version TEXT, evidence_fingerprint TEXT, status_checked_at INTEGER, status_fresh_until INTEGER, revalidate_after INTEGER, invalidated_at INTEGER, invalidation_reason TEXT, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default', severity TEXT DEFAULT 'info');
CREATE TABLE authrim_runtime_probes (
        id TEXT PRIMARY KEY
 NOT NULL
,
        tenant_id TEXT NOT NULL,
        role TEXT NOT NULL,
        probe_kind TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
CREATE TABLE branding_settings (
  id TEXT PRIMARY KEY DEFAULT 'default'
 NOT NULL
,
  custom_css TEXT,
  custom_html_header TEXT,
  custom_html_footer TEXT,
  logo_url TEXT,
  background_image_url TEXT,
  primary_color TEXT DEFAULT '#3B82F6',
  secondary_color TEXT DEFAULT '#10B981',
  font_family TEXT DEFAULT 'Inter',
  -- Authentication method settings
  enabled_auth_methods TEXT DEFAULT '["passkey","magic_link"]', -- JSON array
  password_policy_json TEXT, -- Password policy config (if password auth enabled)
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default');
CREATE TABLE check_api_keys (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL,                    -- SHA-256 hash of the API key
    key_prefix TEXT NOT NULL,                  -- First 8 chars (chk_xxxx) for identification
    allowed_operations TEXT DEFAULT '["check"]', -- JSON array: check, batch, subscribe
    rate_limit_tier TEXT DEFAULT 'moderate',   -- strict, moderate, lenient
    is_active INTEGER DEFAULT 1,
    expires_at INTEGER,                        -- Unix timestamp, NULL = no expiry
    created_by TEXT,                           -- User ID who created this key
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "ciba_requests" (
  auth_req_id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE client_consent_overrides (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'inherit', -- 'required'|'optional'|'hidden'|'inherit'
  min_version TEXT,                      -- null = use tenant default
  enforcement TEXT,                      -- null = use tenant default
  conditional_rules_json TEXT,           -- null = use tenant default
  display_order INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, client_id, statement_id)
);
CREATE TABLE client_trust_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('oidc_client', 'saml_sp')),
  target_id TEXT NOT NULL,
  first_party INTEGER NOT NULL DEFAULT 0,
  trusted INTEGER NOT NULL DEFAULT 0,
  skip_authorization_consent INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, target_type, target_id)
);
CREATE TABLE compliance_reports (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- audit_log, access_report, user_activity, etc.
  name TEXT NOT NULL,           -- Report name/title
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, generating, completed, failed
  requested_by TEXT,            -- User who requested the report
  parameters TEXT,              -- JSON: Report generation parameters
  result_url TEXT,              -- URL to download completed report
  error_message TEXT,           -- Error message if failed
  created_at TEXT NOT NULL,
  completed_at TEXT,            -- When report generation completed
  expires_at TEXT               -- When report download expires
, object_catalog_id TEXT, object_key_base TEXT, artifact_sha256 TEXT, format TEXT
  CHECK (format IS NULL OR format IN ('csv', 'json')), row_count INTEGER, size_bytes INTEGER);
CREATE TABLE consent_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action TEXT NOT NULL,  -- 'granted' | 'updated' | 'revoked' | 'version_upgraded' | 'expired' | 'scopes_updated'
  scopes_before TEXT,    -- JSON array of previous scopes (null for initial grant)
  scopes_after TEXT,     -- JSON array of new scopes (null for revocation)
  privacy_policy_version TEXT,
  tos_version TEXT,
  ip_address_hash TEXT,  -- Hashed IP for privacy
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  metadata_json TEXT,    -- Additional context as JSON
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "consent_item_history" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER
, content_hash_after TEXT);
CREATE TABLE consent_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE TABLE consent_policy_items (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  policy_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT 'required', -- 'required'|'optional'|'hidden'
  version_mode TEXT NOT NULL DEFAULT 'current', -- 'current'|'fixed'|'minimum'
  version_id TEXT,
  min_version TEXT,
  checkbox_mode TEXT NOT NULL DEFAULT 'required', -- 'none'|'required'|'optional'
  checkbox_default_checked INTEGER NOT NULL DEFAULT 0,
  binding_type TEXT, -- 'scope'|'claim'|'saml_attribute'|'destination_field_set'
  binding_value TEXT,
  evidence_profile TEXT,
  language_fallback TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, policy_id, statement_id)
);
CREATE TABLE consent_policy_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version TEXT NOT NULL,
  policy_type TEXT NOT NULL,  -- 'privacy_policy' | 'terms_of_service' | 'cookie_policy'
  policy_uri TEXT,
  policy_hash TEXT,           -- SHA-256 hash of policy content for integrity verification
  effective_at INTEGER NOT NULL,  -- Unix timestamp when this version becomes effective
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, policy_type, version)
);
CREATE TABLE consent_records (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc', 'saml', 'document', 'custom')),
  consent_kind TEXT NOT NULL CHECK (
    consent_kind IN (
      'terms',
      'privacy',
      'attribute_release',
      'scope_claim_release',
      'form_confirmation',
      'custom'
    )
  ),
  client_id TEXT,
  saml_sp_id TEXT,
  recipient_type TEXT CHECK (
    recipient_type IN ('oidc_client', 'saml_sp', 'tenant', 'external_party')
  ),
  recipient_id TEXT,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN ('subject', 'identity_schema', 'destination_field_mapping_set', 'user_decision')
  ),
  binding_key TEXT,
  resource_type TEXT CHECK (
    resource_type IN ('userinfo', 'id_token', 'saml_attributes', 'document', 'custom')
  ),
  resource_id TEXT,
  purpose_key TEXT,
  statement_id TEXT NOT NULL,
  statement_version TEXT NOT NULL,
  policy_id TEXT,
  flow_id TEXT,
  flow_version_id TEXT,
  flow_node_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'once', 'always', 'selected')),
  selected_value TEXT,
  selected_options_json TEXT,
  released_scopes_json TEXT,
  released_claims_json TEXT,
  released_attributes_json TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'revoked', 'expired', 'superseded')
  ),
  expires_at INTEGER,
  revoked_at INTEGER,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE consent_statement_localizations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  version_id TEXT NOT NULL,
  language TEXT NOT NULL,                -- BCP 47: 'en', 'ja', 'de'
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  document_url TEXT,                     -- External document URL (content_type='url')
  inline_content TEXT,                   -- Inline text (content_type='inline')
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, processing_purpose TEXT, withdrawal_impact TEXT,
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id) ON DELETE CASCADE,
  UNIQUE (version_id, language)
);
CREATE TABLE consent_statement_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  version TEXT NOT NULL,                 -- YYYYMMDD fixed: '20250206'
  content_type TEXT NOT NULL DEFAULT 'url', -- 'url' | 'inline'
  effective_at INTEGER NOT NULL,
  content_hash TEXT,                     -- SHA-256 integrity hash
  is_current INTEGER NOT NULL DEFAULT 0,
  current_statement_guard TEXT,
  status TEXT NOT NULL DEFAULT 'draft',  -- 'draft'|'active'|'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, effective_until INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id, version)
);
CREATE TABLE consent_statements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  legal_basis TEXT NOT NULL DEFAULT 'consent',
  processing_purpose TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, record_retention_days INTEGER, withdrawal_allowed INTEGER NOT NULL DEFAULT 1, withdrawal_impact TEXT, reconsent_on_version_change INTEGER NOT NULL DEFAULT 1, reconsent_interval_days INTEGER, definition_generation INTEGER NOT NULL DEFAULT 0
  CHECK (definition_generation BETWEEN 0 AND 9007199254740991), closed_generation INTEGER NOT NULL DEFAULT 0
  CHECK (closed_generation BETWEEN 0 AND 9007199254740991), retired_at INTEGER,
  UNIQUE (tenant_id, slug)
);
CREATE TABLE contact_point_search_indexes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  index_kind TEXT NOT NULL,
  index_value TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1,
  classification TEXT NOT NULL DEFAULT 'internal',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, index_kind, index_value, index_version),
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);
CREATE TABLE contact_points (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  contact_type TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'primary',
  normalized_hash TEXT,
  value_storage_ref TEXT,
  display_label TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);
CREATE TABLE contact_verifications (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  contact_point_id TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  evidence_ref TEXT,
  verified_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_point_id) REFERENCES contact_points(id) ON DELETE CASCADE
);
CREATE TABLE credential_configurations (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    -- Configuration ID (used in metadata)
    configuration_id TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- Verifiable Credential Type
    vct TEXT NOT NULL,
    -- JSON of display information
    display TEXT,
    -- JSON of claims configuration
    claims TEXT,
    -- JSON of proof types supported
    proof_types_supported TEXT,
    -- Signing algorithm
    signing_alg TEXT DEFAULT 'ES256',
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, configuration_id)
);
CREATE TABLE credential_offers (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Credential configuration ID
    credential_configuration_id TEXT NOT NULL,
    -- Pre-authorized code
    pre_authorized_code TEXT,
    -- Transaction code (PIN)
    tx_code TEXT,
    -- JSON of grants configuration
    grants TEXT NOT NULL,
    -- Status: 'pending' | 'accepted' | 'issued' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    issued_at TEXT,
    issued_credential_id TEXT,
    issued_credential_internal_id TEXT,
    FOREIGN KEY (issued_credential_internal_id) REFERENCES issued_credentials(internal_id)
);
CREATE TABLE custom_claim_schema_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  schema_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete','rename','toggle_active')),
  snapshot TEXT NOT NULL,
  changes TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT CHECK(actor_type IN ('user','admin','system','api')),
  change_source TEXT CHECK(change_source IN ('admin_api','admin_ui','migration','rollback')),
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, schema_id, version)
);
CREATE TABLE custom_claim_schemas (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  active_field_key TEXT,
  display_label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'string',
  is_pii INTEGER NOT NULL DEFAULT 0,
  is_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  validation_rules TEXT CHECK(validation_rules IS NULL OR json_valid(validation_rules)),
  include_in_id_token INTEGER NOT NULL DEFAULT 0,
  include_in_userinfo INTEGER NOT NULL DEFAULT 0,
  include_in_introspection INTEGER NOT NULL DEFAULT 0,
  required_scopes TEXT CHECK(required_scopes IS NULL OR json_valid(required_scopes)),
  scope_mode TEXT NOT NULL DEFAULT 'any' CHECK(scope_mode IN ('all', 'any')),
  is_searchable INTEGER NOT NULL DEFAULT 1,
  is_exportable INTEGER NOT NULL DEFAULT 1,
  is_vc_claim INTEGER NOT NULL DEFAULT 0,
  claim_namespace TEXT,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  operation_status TEXT NOT NULL DEFAULT 'active',
  operation_detail TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  show_on_registration    INTEGER NOT NULL DEFAULT 0,
  registration_required   INTEGER NOT NULL DEFAULT 0,
  registration_order      INTEGER NOT NULL DEFAULT 0,
  registration_placeholder TEXT
, ui_group_key TEXT, ui_group_label TEXT, ui_group_order INTEGER NOT NULL DEFAULT 0, ui_field_order INTEGER NOT NULL DEFAULT 0, examples_json TEXT CHECK(examples_json IS NULL OR json_valid(examples_json)), cardinality TEXT NOT NULL DEFAULT 'single'
  CHECK (cardinality IN ('single', 'multi')));
INSERT INTO custom_claim_schemas VALUES('builtin:default:display_name','default','display_name','display_name','Display Name','string',1,0,1,NULL,0,0,0,NULL,'any',1,1,0,NULL,NULL,1,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,1,'{"values":["John Doe","山田 太郎"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:locale','default','locale','locale','Locale','string',0,0,1,NULL,0,0,0,NULL,'any',0,1,0,NULL,NULL,6,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,6,'{"values":["ja-JP","en-US"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:email','default','email','email','Email','string',1,0,1,NULL,0,0,0,NULL,'any',1,1,0,NULL,NULL,20,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'contact','Contact',20,1,'{"values":["john@example.com"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:email_verified','default','email_verified','email_verified','Email Verified','boolean',0,0,1,NULL,0,0,0,NULL,'any',0,0,0,NULL,NULL,21,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'contact','Contact',20,2,'{"values":[true]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:given_name','default','given_name','given_name','Given Name','string',1,0,1,NULL,0,0,0,NULL,'any',1,1,0,NULL,NULL,2,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,2,'{"values":["John","太郎"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:family_name','default','family_name','family_name','Family Name','string',1,0,1,NULL,0,0,0,NULL,'any',1,1,0,NULL,NULL,3,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,3,'{"values":["Doe","山田"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:preferred_username','default','preferred_username','preferred_username','Preferred Username','string',0,0,1,NULL,0,0,0,NULL,'any',1,1,0,NULL,NULL,4,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,4,'{"values":["jdoe"]}','single');
INSERT INTO custom_claim_schemas VALUES('builtin:default:picture_url','default','picture_url','picture_url','Picture URL','string',1,0,1,NULL,0,0,0,NULL,'any',0,1,0,NULL,NULL,5,1,'active',NULL,1,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,0,0,0,NULL,'profile','Profile',10,5,'{"values":["https://example.com/users/jdoe/photo.jpg"]}','single');
CREATE TABLE data_export_requests (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'processing' | 'completed' | 'failed' | 'expired'
  format TEXT NOT NULL DEFAULT 'json',     -- 'json' | 'csv'
  include_sections TEXT NOT NULL,          -- JSON array: ["profile", "consents", "sessions", "audit_log", "passkeys"]
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  expires_at INTEGER,                      -- Download link expiration
  file_path TEXT,                          -- R2 object path (for async exports)
  object_catalog_id TEXT,                  -- object_catalog pointer for materialized export artifacts
  file_size INTEGER,
  error_message TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE TABLE delegations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  delegate_subject_id TEXT NOT NULL,
  parent_delegation_id TEXT,
  chain_id TEXT,
  delegation_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  scope_json TEXT,
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "device_codes" (
  device_code TEXT PRIMARY KEY
 NOT NULL
,
  user_code TEXT UNIQUE NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  user_id TEXT,
  sub TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  token_issued INTEGER DEFAULT 0,
  token_issued_at INTEGER,
  poll_count INTEGER DEFAULT 0,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (tenant_id, client_id)
    REFERENCES oauth_clients(tenant_id, client_id)
    ON DELETE CASCADE
);
CREATE TABLE device_installations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  linked_device_secret_id TEXT,
  session_id TEXT,
  display_name TEXT,
  device_platform TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE device_secrets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  device_name TEXT,
  device_platform TEXT,
  installation_id TEXT,
  client_id TEXT,
  trust_group_id TEXT,
  source_installation_id TEXT,
  source_client_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  revoke_reason TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE did_document_cache (
    did TEXT PRIMARY KEY
 NOT NULL
,
    -- JSON of DID Document
    document TEXT NOT NULL,
    resolved_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL
);
CREATE TABLE directory_auth_config_history (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  before_redacted_json TEXT NOT NULL DEFAULT '{}',
  after_redacted_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE directory_auth_evidence_exports (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed', 'deleted', 'expired')),
  requested_by TEXT NOT NULL,
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER NOT NULL,
  size_estimate_bytes INTEGER,
  artifact_key TEXT,
  artifact_sha256 TEXT,
  object_catalog_id TEXT,
  manifest_signature_key_id TEXT,
  manifest_signature_alg TEXT,
  signed_url_expires_at INTEGER,
  retention_expires_at INTEGER NOT NULL,
  download_after_delete INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
);
CREATE TABLE directory_auth_migration_campaigns (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'disabled'
    CHECK (status IN ('disabled', 'draft', 'active', 'paused', 'archived')),
  mode TEXT NOT NULL DEFAULT 'directory_login_allowed'
    CHECK (mode IN (
      'directory_login_allowed',
      'prompt_passkey',
      'grace_then_require_passkey',
      'require_passkey_after_directory',
      'disabled'
    )),
  passkey_prompt_mode TEXT NOT NULL DEFAULT 'campaign_only'
    CHECK (passkey_prompt_mode IN ('none', 'optional', 'campaign_only')),
  email_code_fallback_mode TEXT NOT NULL DEFAULT 'migration_recovery'
    CHECK (email_code_fallback_mode IN (
      'tenant_default',
      'migration_recovery',
      'directory_unavailable_recovery',
      'admin_invitation_only',
      'login_method',
      'disabled'
    )),
  grace_period_days INTEGER NOT NULL DEFAULT 30,
  transaction_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  enforcement_start_mode TEXT NOT NULL DEFAULT 'first_directory_login'
    CHECK (enforcement_start_mode IN ('first_directory_login')),
  target_policy_json TEXT NOT NULL DEFAULT '{}',
  is_template INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE TABLE directory_auth_migration_transaction_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE directory_auth_migration_transactions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL
    CHECK (scope IN ('passkey_enrollment', 'email_code_fallback', 'recovery', 'status_display')),
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'completed', 'expired', 'blocked')),
  request_id TEXT,
  authorization_challenge_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  blocked_reason TEXT,
  UNIQUE (tenant_id, token_hash)
);
CREATE TABLE directory_auth_migration_user_states (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  user_id TEXT,
  connector_id TEXT,
  directory_subject TEXT,
  cohort_key TEXT,
  state TEXT NOT NULL DEFAULT 'eligible'
    CHECK (state IN (
      'not_applicable',
      'eligible',
      'prompted',
      'deferred',
      'passkey_required',
      'enrolled',
      'blocked',
      'recovered'
    )),
  first_directory_login_at INTEGER,
  prompted_at INTEGER,
  deferred_until INTEGER,
  passkey_required_at INTEGER,
  enrolled_at INTEGER,
  blocked_reason TEXT,
  recovery_reason TEXT,
  reset_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at INTEGER,
  last_reset_by TEXT,
  last_reset_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, campaign_id, user_id),
  UNIQUE (tenant_id, campaign_id, connector_id, directory_subject)
);
CREATE TABLE directory_auth_release_advisories (
  id TEXT PRIMARY KEY
 NOT NULL
,
  channel TEXT NOT NULL DEFAULT 'stable',
  severity TEXT NOT NULL
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  affected_versions_json TEXT NOT NULL DEFAULT '[]',
  fixed_version TEXT,
  summary TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  release_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE directory_auth_retention_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
  authrim_audit_retention_days INTEGER NOT NULL DEFAULT 365,
  wordwarden_local_retention_days INTEGER,
  artifact_delete_grace_hours INTEGER NOT NULL DEFAULT 72,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE directory_auth_support_bundles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  redaction_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (redaction_level IN ('minimal', 'standard', 'detailed')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'ready', 'failed', 'deleted', 'expired')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  consent_summary_json TEXT NOT NULL DEFAULT '{}',
  artifact_key TEXT,
  artifact_sha256 TEXT,
  object_catalog_id TEXT,
  retention_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  deleted_at INTEGER
);
CREATE TABLE directory_auth_tenant_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
  email_code_fallback_mode TEXT NOT NULL DEFAULT 'migration_recovery'
    CHECK (email_code_fallback_mode IN (
      'migration_recovery',
      'directory_unavailable_recovery',
      'admin_invitation_only',
      'login_method',
      'disabled'
    )),
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE directory_connector_instances (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  display_name TEXT,
  transport TEXT NOT NULL,
  version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  health_status TEXT NOT NULL,
  health_summary_json TEXT NOT NULL DEFAULT '{}',
  config_fingerprint TEXT NOT NULL,
  config_categories_json TEXT NOT NULL DEFAULT '[]',
  drift_severity TEXT NOT NULL DEFAULT 'none'
    CHECK (drift_severity IN ('none', 'warning', 'critical')),
  deactivated_at INTEGER,
  deactivated_by TEXT,
  deactivation_reason TEXT,
  updated_at INTEGER NOT NULL, release_channel TEXT NOT NULL DEFAULT 'stable',
  UNIQUE (tenant_id, connector_id, instance_id)
);
CREATE TABLE directory_connector_status_episodes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('connected', 'disconnected', 'stale', 'version_mismatch', 'unhealthy', 'deactivated')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  reason TEXT,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE directory_identity_links (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  user_id TEXT NOT NULL,
  latest_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (tenant_id, connector_id, directory_subject)
);
CREATE TABLE directory_jit_pending_users (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  directory_subject TEXT NOT NULL,
  login_identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'linked')),
  directory_facts_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  decision_reason TEXT,
  linked_user_id TEXT,
  UNIQUE (tenant_id, connector_id, directory_subject)
);
CREATE TABLE entitlements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  entitlement_type TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  source_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  value_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, entitlement_type, entitlement_key, subject_id, account_id)
);
CREATE TABLE event_log (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL,
  result TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  error_code TEXT,
  error_message TEXT,
  anonymized_user_id TEXT,
  client_id TEXT,
  session_id TEXT,
  request_id TEXT,
  duration_ms INTEGER,
  details_r2_key TEXT,
  details_json TEXT,
  retention_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE external_idp_auth_states (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                        -- Client ID from the original auth request
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier for Authrim ↔ External IdP
  code_challenge TEXT,                   -- PKCE code challenge from client ↔ Authrim
  flow_id TEXT,                          -- Flow ID for diagnostic logging correlation
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- OIDC Core 1.0 parameters (for validation in callback)
  max_age INTEGER,                       -- max_age parameter for auth_time validation
  acr_values TEXT,                       -- acr_values parameter for acr validation

  -- Silent Auth & SSO control (Phase 1 & 2)
  prompt TEXT,                           -- OIDC prompt parameter (none, login, consent, select_account)
  enable_sso INTEGER NOT NULL DEFAULT 1, -- 1 = SSO enabled (handoff), 0 = SSO disabled (Direct Auth)

  -- Timestamps
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER, reauth_challenge_id TEXT, reauth_requested_at INTEGER, invite_id TEXT, invite_reservation_id TEXT, attempt_interaction_id TEXT,                   -- When state was consumed (for single-use)

  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
CREATE TABLE external_lifecycle_signal_decisions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  signal_event_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  decision TEXT NOT NULL,
  propagation_targets_json TEXT,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (signal_event_id) REFERENCES external_lifecycle_signal_events(id) ON DELETE CASCADE
);
CREATE TABLE external_lifecycle_signal_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_timestamp INTEGER,
  observed_at INTEGER NOT NULL,
  binding_version TEXT,
  payload_ref TEXT,
  signal_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  processing_state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, source_type, source_id, dedupe_key)
);
CREATE TABLE field_usage_bindings (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  field_key TEXT NOT NULL,
  binding_type TEXT NOT NULL CHECK (
    binding_type IN (
      'authentication_method',
      'notification',
      'discovery',
      'consent',
      'policy',
      'protocol_output',
      'display',
      'ui',
      'custom'
    )
  ),
  binding_id TEXT NOT NULL,
  protection TEXT NOT NULL DEFAULT 'warn' CHECK (
    protection IN ('none', 'warn', 'delete_blocked')
  ),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'admin' CHECK (
    source IN ('system', 'admin', 'derived', 'migration')
  ),
  metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, field_key, binding_type, binding_id)
);
CREATE TABLE IF NOT EXISTS "flow_assignments" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  target_type TEXT NOT NULL CHECK (
    target_type IN ('tenant', 'oidc_client', 'saml_sp', 'credential_profile')
  ),
  target_id TEXT,
  flow_kind TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (target_type = 'tenant' AND target_id IS NULL)
    OR (target_type IN ('oidc_client', 'saml_sp', 'credential_profile') AND target_id IS NOT NULL)
  ),
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
);
INSERT INTO flow_assignments VALUES('flow-assignment-default-login','default','tenant',NULL,'login','flow-default-login-no-consent',1,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO flow_assignments VALUES('flow-assignment-default-registration','default','tenant',NULL,'registration','flow-default-registration-no-consent',1,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
CREATE TABLE flow_audit_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  node_id TEXT,
  branch_handle_id TEXT,
  event_type TEXT NOT NULL,
  result TEXT,
  error_code TEXT,
  contract_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
, method TEXT, reason_code TEXT, subject_hash TEXT, inquiry_number TEXT);
CREATE TABLE flow_interaction_steps (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  interaction_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'waiting_input', 'processing', 'completed', 'skipped', 'failed')
  ),
  selected_handle TEXT,
  state_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES flow_interactions(id) ON DELETE CASCADE
);
CREATE TABLE flow_interactions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  flow_version_id TEXT NOT NULL,
  user_id TEXT,
  client_id TEXT,
  saml_sp_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'active', 'completed', 'expired', 'failed')),
  current_node_id TEXT,
  current_step_id TEXT,
  contract_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER, context_json TEXT,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  FOREIGN KEY (flow_version_id) REFERENCES flow_versions(id) ON DELETE CASCADE
);
CREATE TABLE flow_versions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  flow_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  runtime_snapshot_json TEXT NOT NULL,
  editor_snapshot_json TEXT,
  validation_result_json TEXT NOT NULL,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, flow_id, version_number)
);
INSERT INTO flow_versions VALUES('flow-version-default-login-no-consent-v1','default','flow-default-login-no-consent',1,'authrim.login_ui.contract.v1','{"flow_kind":"login","flow_id":"flow-default-login-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete:step","source_node_id":"saml-attribute-release-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete:step","source_node_id":"oidc-authorization-complete","component":"completion","render":true,"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":522,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"saml-attribute-release-complete","type":"complete","title":"Complete","position":{"x":108,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-authorization-complete","type":"complete","title":"Complete","position":{"x":594,"y":612},"config":{"ui_kind":"end","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->saml-attribute-release-complete","source":"session-check","source_handle":"continue","target":"saml-attribute-release-complete"},{"id":"session-check:continue->oidc-authorization-complete","source":"session-check","source_handle":"continue","target":"oidc-authorization-complete"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->saml-attribute-release-complete","source":"authentication","source_handle":"mail_otp","target":"saml-attribute-release-complete"},{"id":"authentication:mail_otp->oidc-authorization-complete","source":"authentication","source_handle":"mail_otp","target":"oidc-authorization-complete"},{"id":"authentication:totp->saml-attribute-release-complete","source":"authentication","source_handle":"totp","target":"saml-attribute-release-complete"},{"id":"authentication:totp->oidc-authorization-complete","source":"authentication","source_handle":"totp","target":"oidc-authorization-complete"},{"id":"authentication:passkey->saml-attribute-release-complete","source":"authentication","source_handle":"passkey","target":"saml-attribute-release-complete"},{"id":"authentication:passkey->oidc-authorization-complete","source":"authentication","source_handle":"passkey","target":"oidc-authorization-complete"},{"id":"authentication:facebook->saml-attribute-release-complete","source":"authentication","source_handle":"facebook","target":"saml-attribute-release-complete"},{"id":"authentication:facebook->oidc-authorization-complete","source":"authentication","source_handle":"facebook","target":"oidc-authorization-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"valid":true,"errors":[],"warnings":[],"issues":[]}','system',__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO flow_versions VALUES('flow-version-default-registration-no-consent-v1','default','flow-default-registration-no-consent',1,'authrim.login_ui.contract.v1','{"flow_kind":"registration","flow_id":"flow-default-registration-no-consent","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"start"}},{"id":"registration-method:step","source_node_id":"registration-method","component":"registration_method_selector","render":true,"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create:step","source_node_id":"account-create","component":"account_action","render":false,"config":{"ui_kind":"account"}},{"id":"output:step","source_node_id":"output","component":"completion","render":true,"config":{"ui_kind":"end"}}]}}','{"nodes":[{"id":"request","type":"entry","title":"Registration Request","position":{"x":360,"y":0},"config":{"ui_kind":"start"}},{"id":"registration-method","type":"registration","title":"Registration Method","position":{"x":360,"y":144},"config":{"ui_kind":"registration","authentication_profile_ref":"default","screen_ref":"registration","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"account-create","type":"account_action","title":"Account Creation","position":{"x":360,"y":288},"config":{"ui_kind":"account"}},{"id":"output","type":"complete","title":"Complete","position":{"x":360,"y":432},"config":{"ui_kind":"end"}}],"edges":[{"id":"request:next->registration-method","source":"request","source_handle":"next","target":"registration-method"},{"id":"registration-method:mail_otp->account-create","source":"registration-method","source_handle":"mail_otp","target":"account-create"},{"id":"registration-method:totp->account-create","source":"registration-method","source_handle":"totp","target":"account-create"},{"id":"registration-method:passkey->account-create","source":"registration-method","source_handle":"passkey","target":"account-create"},{"id":"registration-method:facebook->account-create","source":"registration-method","source_handle":"facebook","target":"account-create"},{"id":"account-create:completed->output","source":"account-create","source_handle":"completed","target":"output"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"valid":true,"errors":[],"warnings":[],"issues":[]}','system',__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
INSERT INTO flow_versions VALUES('flow-version-saml-sp-oidc-rp-v1','default','flow-saml-sp-oidc-rp',1,'authrim.login_ui.contract.v1','{"flow_kind":"login","flow_id":"flow-saml-sp-oidc-rp","ui":{"steps":[{"id":"request:step","source_node_id":"request","component":"interaction_context","render":false,"config":{"ui_kind":"entry"}},{"id":"session-check:step","source_node_id":"session-check","component":"session_check","render":false,"config":{"ui_kind":"session"}},{"id":"authentication:step","source_node_id":"authentication","component":"authentication_method_selector","render":true,"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition:step","source_node_id":"protocol-condition","component":"condition","render":false,"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete:step","source_node_id":"saml-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete:step","source_node_id":"oidc-complete","component":"completion","render":true,"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}]}}','{"nodes":[{"id":"request","type":"entry","title":"Login Request","position":{"x":360,"y":0},"config":{"ui_kind":"entry"}},{"id":"session-check","type":"session_check","title":"Session Check","position":{"x":360,"y":144},"config":{"ui_kind":"session"}},{"id":"authentication","type":"authentication","title":"Authentication Method","position":{"x":520,"y":288},"config":{"ui_kind":"authentication","authentication_profile_ref":"default","screen_ref":"login","outputs":[{"id":"mail_otp","label":"Email OTP"},{"id":"totp","label":"Authenticator app"},{"id":"passkey","label":"Passkey"},{"id":"facebook","label":"Facebook"}]}},{"id":"protocol-condition","type":"condition","title":"Protocol Branch","position":{"x":360,"y":432},"config":{"ui_kind":"condition","conditions":{"rows":[{"id":"saml","label":"SAML","condition":{"type":"protocol","value":"saml"},"output_handle":"saml"},{"id":"oidc","label":"OIDC","condition":{"type":"protocol","value":"oidc"},"output_handle":"oidc"}],"otherwise":{"terminal_error":{"error":"unsupported_protocol","message":"This Flow accepts only SAML and OIDC login requests."}}}}},{"id":"saml-complete","type":"complete","title":"SAML End","position":{"x":120,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"saml-attribute-release-completion","label":"SAML Attribute Release Completion","protocol":"saml","purpose":"attribute_release","role":"output"}}},{"id":"oidc-complete","type":"complete","title":"OIDC End","position":{"x":600,"y":600},"config":{"ui_kind":"complete","completion_block":{"id":"oidc-authorization-completion","label":"OIDC Authorization Completion","protocol":"oidc","purpose":"authorization","role":"output"}}}],"edges":[{"id":"request:next->session-check","source":"request","source_handle":"next","target":"session-check"},{"id":"session-check:continue->protocol-condition","source":"session-check","source_handle":"continue","target":"protocol-condition"},{"id":"session-check:authenticate->authentication","source":"session-check","source_handle":"authenticate","target":"authentication"},{"id":"authentication:mail_otp->protocol-condition","source":"authentication","source_handle":"mail_otp","target":"protocol-condition"},{"id":"authentication:totp->protocol-condition","source":"authentication","source_handle":"totp","target":"protocol-condition"},{"id":"authentication:passkey->protocol-condition","source":"authentication","source_handle":"passkey","target":"protocol-condition"},{"id":"authentication:facebook->protocol-condition","source":"authentication","source_handle":"facebook","target":"protocol-condition"},{"id":"protocol-condition:saml->saml-complete","source":"protocol-condition","source_handle":"saml","target":"saml-complete"},{"id":"protocol-condition:oidc->oidc-complete","source":"protocol-condition","source_handle":"oidc","target":"oidc-complete"}],"viewport":{"x":36,"y":36,"zoom":1}}','{"valid":true,"errors":[],"warnings":[],"issues":[]}','system',__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
CREATE TABLE group_memberships (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_id TEXT NOT NULL,
  subject_id TEXT,
  account_id TEXT,
  membership_type TEXT NOT NULL DEFAULT 'member',
  assignment_source TEXT NOT NULL DEFAULT 'manual',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_id, subject_id, account_id, membership_type),
  FOREIGN KEY (group_id) REFERENCES "groups"(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "groups" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  group_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  parent_group_id TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, group_key)
);
CREATE TABLE guest_account_upgrades (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  guest_user_id TEXT NOT NULL,
  upgraded_user_id TEXT NOT NULL,
  upgrade_method TEXT NOT NULL,
  provider_id TEXT,
  preserve_sub INTEGER NOT NULL DEFAULT 1 CHECK (preserve_sub = 1),
  upgraded_at BIGINT NOT NULL,
  data_migrated INTEGER NOT NULL DEFAULT 0 CHECK (data_migrated IN (0, 1))
);
CREATE TABLE guest_deletion_audit_outbox (
  audit_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 4096),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'retry', 'succeeded')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  succeeded_at INTEGER, execution_progress_json TEXT
  CHECK (execution_progress_json IS NULL OR
    (json_valid(execution_progress_json) AND length(CAST(execution_progress_json AS BLOB))<=16384)),
  UNIQUE (tenant_id, operation_id),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL) OR
         (status <> 'succeeded' AND succeeded_at IS NULL))
);
CREATE TABLE guest_devices (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  resume_credential_hash TEXT NOT NULL CHECK (length(resume_credential_hash) = 64),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);
CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY
 NOT NULL
,          -- Composite: tenant_id:actor_id:method:path:resource_id:key
    tenant_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,       -- admin_id who made the request
    method TEXT NOT NULL,         -- HTTP method (POST, PUT, DELETE)
    path TEXT NOT NULL,           -- API path pattern
    resource_id TEXT,             -- Target resource ID (if applicable)
    idempotency_key TEXT NOT NULL,-- The Idempotency-Key header value
    body_hash TEXT NOT NULL,      -- SHA-256 hash of request body
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,  -- Sanitized response (PII removed)
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE identity_accounts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  account_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  legacy_user_id TEXT,
  primary_subject_id TEXT,
  display_label TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER, directory_publication_state TEXT NOT NULL DEFAULT 'pending'
  CHECK (directory_publication_state IN ('pending', 'active_pending_directory', 'active', 'disabled')), account_route_generation INTEGER NOT NULL DEFAULT 1
  CHECK (account_route_generation >= 1), registration_state TEXT NOT NULL DEFAULT 'registered'
  CHECK (registration_state IN ('guest', 'registered')),
  FOREIGN KEY (primary_subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL
);
CREATE TABLE identity_binding_lookup_indexes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  identity_binding_id TEXT NOT NULL,
  lookup_kind TEXT NOT NULL,
  lookup_value TEXT NOT NULL,
  lookup_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, lookup_kind, lookup_value, lookup_version),
  FOREIGN KEY (identity_binding_id) REFERENCES identity_bindings(id) ON DELETE CASCADE
);
CREATE TABLE identity_bindings (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT,
  protocol TEXT NOT NULL,
  source_id TEXT NOT NULL,
  provider_subject_key_hash TEXT NOT NULL,
  binding_kind TEXT NOT NULL DEFAULT 'external_subject',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  assurance_level TEXT,
  trust_context_snapshot_id TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  last_seen_at INTEGER,
  UNIQUE (tenant_id, protocol, source_id, provider_subject_key_hash),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL
);
CREATE TABLE identity_providers (
  id TEXT PRIMARY KEY
 NOT NULL
,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, tenant_id TEXT NOT NULL DEFAULT 'default');
CREATE TABLE identity_resolution_candidates (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  source_id TEXT NOT NULL,
  candidate_subject_id TEXT,
  candidate_account_id TEXT,
  candidate_binding_id TEXT,
  candidate_score INTEGER NOT NULL DEFAULT 0,
  risk_tier TEXT,
  decision_state TEXT NOT NULL DEFAULT 'pending',
  reason_codes_json TEXT,
  review_task_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE identity_resolution_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  binding_id TEXT,
  source_id TEXT NOT NULL,
  resolution_method TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (binding_id) REFERENCES identity_bindings(id) ON DELETE SET NULL
);
CREATE TABLE identity_subjects (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  display_label TEXT,
  primary_account_id TEXT,
  risk_tier TEXT,
  assurance_level TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE internal_notification_delivery_attempts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  event_id TEXT NOT NULL,
  route_id TEXT,
  provider TEXT NOT NULL,
  destination_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'failed', 'dead_letter', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error_class TEXT,
  error_message TEXT,
  next_attempt_at INTEGER,
  payload_sha256 TEXT,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE internal_notification_delivery_routes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  name TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'platform' CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL DEFAULT 'global',
  provider TEXT NOT NULL CHECK (provider IN ('webhook', 'email', 'slack', 'custom')),
  destination_id TEXT,
  categories_json TEXT,
  severities_json TEXT,
  min_severity TEXT NOT NULL DEFAULT 'medium'
    CHECK (min_severity IN ('critical', 'high', 'medium', 'low', 'info')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  failure_policy TEXT NOT NULL DEFAULT 'retry_until_dead_letter'
    CHECK (failure_policy IN ('best_effort', 'retry_until_dead_letter', 'fail_closed')),
  max_attempts INTEGER NOT NULL DEFAULT 5,
  retry_after_seconds INTEGER NOT NULL DEFAULT 300,
  suppression_key TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS "internal_notification_events" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (
    category IN (
      'identity_mapping_signal',
      'identity_mapping_manual_review',
      'identity_mapping_propagation_failure',
      'identity_mapping_bulk_impact',
      'storage_registry_security',
      'storage_registry_health',
      'tenant_database_stats',
      'tenant_database_health',
      'control_plane_drift',
      'logging_destination_health',
      'logging_delivery_failure',
      'logging_fallback_used',
      'logging_dlq_backlog',
      'logging_quota_warning',
      'logging_repair_job_status',
      'notification_delivery_failure'
    )
  ),
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivered', 'failed', 'dead_letter', 'suppressed')
  ),
  deduplication_key TEXT,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);
CREATE TABLE issued_credentials (
    internal_id TEXT PRIMARY KEY
 NOT NULL
,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Verifiable Credential Type
    credential_type TEXT NOT NULL,
    -- Format: 'dc+sd-jwt' | 'mso_mdoc'
    format TEXT NOT NULL,
    -- JSON of claims included in credential
    claims TEXT NOT NULL,
    -- Status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    -- Status list for revocation/suspension
    status_list_id TEXT,
    status_list_internal_id TEXT,
    status_list_index INTEGER,
    holder_binding TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    revoked_reason TEXT,
    UNIQUE (tenant_id, public_id),
    FOREIGN KEY (status_list_internal_id) REFERENCES status_lists(internal_id)
);
CREATE TABLE legal_hold_events (
  event_id TEXT PRIMARY KEY
 NOT NULL
,
  hold_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'extended', 'released', 'expired')),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  effective_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(event_id) BETWEEN 1 AND 256),
  CHECK (length(actor_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (created_at >= effective_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);
CREATE TABLE legal_hold_projection_outbox (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  hold_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  projection_generation INTEGER NOT NULL CHECK (projection_generation >= 1),
  hold_version INTEGER NOT NULL CHECK (hold_version >= 1),
  projection_state TEXT NOT NULL CHECK (projection_state IN ('active', 'inactive')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (hold_id) REFERENCES legal_holds(id) ON DELETE CASCADE,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (hold_id, hold_version),
  UNIQUE (tenant_id, account_id, projection_generation)
);
CREATE TABLE legal_holds (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'account' CHECK (subject_type = 'account'),
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'released', 'expired')),
  reason_code TEXT NOT NULL,
  case_reference TEXT,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  released_by TEXT,
  released_at INTEGER,
  release_reason TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(subject_id) BETWEEN 1 AND 256),
  CHECK (length(reason_code) BETWEEN 1 AND 64),
  CHECK (case_reference IS NULL OR length(case_reference) BETWEEN 1 AND 256),
  CHECK (length(created_by) BETWEEN 1 AND 256),
  CHECK (released_by IS NULL OR length(released_by) BETWEEN 1 AND 256),
  CHECK (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 256),
  CHECK (expires_at IS NULL OR expires_at >= created_at),
  CHECK (
    (state = 'active' AND released_by IS NULL AND released_at IS NULL AND release_reason IS NULL) OR
    (state IN ('released', 'expired') AND released_by IS NOT NULL AND released_at IS NOT NULL AND
      release_reason IS NOT NULL)
  ),
  CHECK (released_at IS NULL OR released_at >= created_at),
  CHECK (updated_at >= created_at)
);
CREATE TABLE log_chunk_manifests (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  bucket_start_at INTEGER NOT NULL,
  bucket_end_at INTEGER NOT NULL,
  shard TEXT NOT NULL,
  manifest_object_key TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  checksum_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'repair_needed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE log_object_catalog (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_key TEXT NOT NULL,
  log_type TEXT NOT NULL,
  plane TEXT NOT NULL,
  surface TEXT,
  object_key TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('chunk', 'manifest', 'dlq_payload', 'export_artifact')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'orphan_candidate', 'deleted')),
  record_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  compression TEXT CHECK (compression IN ('none', 'gzip_block')),
  encryption_scope TEXT,
  key_version INTEGER,
  created_at INTEGER NOT NULL,
  committed_at INTEGER,
  deleted_at INTEGER
);
CREATE TABLE logging_catalog_repair_jobs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('scan', 'apply_safe', 'dangerous_preview', 'dangerous_apply')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'cancel_requested', 'cancelled')
  ),
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  requested_action TEXT,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER,
  preview_artifact_ref TEXT,
  result_json TEXT,
  error_class TEXT,
  last_error TEXT,
  requested_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancel_requested_at INTEGER,
  cancel_requested_by TEXT,
  metadata_json TEXT
);
CREATE TABLE logging_quota_evaluations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  quota_policy_id TEXT NOT NULL,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT,
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL,
  soft_limit INTEGER,
  hard_limit INTEGER,
  state TEXT NOT NULL CHECK (state IN ('ok', 'warning', 'soft_exceeded', 'hard_exceeded')),
  enforcement_action TEXT NOT NULL CHECK (
    enforcement_action IN ('none', 'notify', 'throttle_non_critical', 'block_non_critical')
  ),
  evaluated_at INTEGER NOT NULL,
  notification_event_id TEXT,
  metadata_json TEXT
);
CREATE TABLE logging_quota_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('platform', 'tenant')),
  scope_id TEXT NOT NULL,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL DEFAULT 'day' CHECK (window_kind IN ('hour', 'day')),
  soft_limit INTEGER,
  hard_limit INTEGER,
  warning_ratio REAL NOT NULL DEFAULT 0.8,
  enforcement_mode TEXT NOT NULL DEFAULT 'warn_only'
    CHECK (enforcement_mode IN ('disabled', 'observe', 'warn_only', 'soft_limit', 'hard_non_critical')),
  critical_behavior TEXT NOT NULL DEFAULT 'never_block' CHECK (critical_behavior IN ('never_block')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_by TEXT,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE logging_usage_aggregates (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT,
  tenant_key TEXT,
  log_type TEXT,
  plane TEXT,
  lane TEXT CHECK (lane IS NULL OR lane IN ('critical', 'default', 'bulk')),
  metric_name TEXT NOT NULL,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('hour', 'day')),
  window_start_at INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  source_table TEXT NOT NULL,
  metadata_json TEXT,
  refreshed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE lookup_retention_policies (
  tenant_id TEXT PRIMARY KEY
 NOT NULL
,
  retention_days INTEGER NOT NULL DEFAULT 180 CHECK (retention_days BETWEEN 30 AND 3650),
  policy_generation INTEGER NOT NULL DEFAULT 1 CHECK (policy_generation >= 1),
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(updated_by) BETWEEN 1 AND 256),
  CHECK (updated_at >= created_at)
);
INSERT INTO lookup_retention_policies VALUES('default',180,1,'migration:051',__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__);
CREATE TABLE lookup_retention_policy_projection_outbox (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  policy_generation INTEGER NOT NULL CHECK (policy_generation >= 1),
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'succeeded', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  CHECK (length(operation_id) BETWEEN 1 AND 256),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR
         (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded' AND completed_at IS NOT NULL) OR status <> 'succeeded'),
  CHECK (updated_at >= created_at),
  UNIQUE (tenant_id, policy_generation)
);
INSERT INTO lookup_retention_policy_projection_outbox VALUES('lookup-retention-policy:init:' || lower(hex(randomblob(16))),'default',1,180,'pending',0,__AUTHRIM_NOW_EPOCH_SECONDS__,NULL,NULL,NULL,__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,NULL);
CREATE TABLE migration_metadata (
  id TEXT PRIMARY KEY DEFAULT 'global'
 NOT NULL
,
  current_version INTEGER NOT NULL DEFAULT 0,
  last_migration_at INTEGER,
  environment TEXT DEFAULT 'development',
  metadata_json TEXT
);
CREATE TABLE notification_delivery_intents (
  intent_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  provider_order_version INTEGER NOT NULL CHECK (provider_order_version >= 1),
  provider_installation_ids_json TEXT NOT NULL
    CHECK (json_valid(provider_installation_ids_json)
      AND json_type(provider_installation_ids_json) = 'array'
      AND json_array_length(provider_installation_ids_json) BETWEEN 1 AND 8),
  active_provider_index INTEGER NOT NULL DEFAULT 0 CHECK (active_provider_index BETWEEN 0 AND 7),
  provider_started_at INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  notification_kind TEXT NOT NULL,
  payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version = 1),
  payload_key_id TEXT,
  payload_envelope_json TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(request_fingerprint) = 64),
  fingerprint_key_id TEXT NOT NULL
    CHECK (fingerprint_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(fingerprint_key_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'canceled', 'expired', 'dead_letter')),
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  canceled_at INTEGER,
  dead_lettered_at INTEGER,
  delete_after INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, account_id TEXT, recipient_masked TEXT, recipient_encrypted TEXT, recipient_encryption_key_version INTEGER, provider_message_id TEXT, provider_accepted_at INTEGER, delivery_status TEXT NOT NULL DEFAULT 'requested'
  CHECK (delivery_status IN (
    'requested', 'provider_accepted', 'delivered', 'deferred', 'bounced', 'failed',
    'rejected', 'complained', 'unknown'
  )), delivery_status_updated_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (attempt_count >= 0), last_error_code TEXT,
  UNIQUE (tenant_id, idempotency_key),
  CHECK (length(intent_id) BETWEEN 1 AND 256),
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (active_provider_index < json_array_length(provider_installation_ids_json)),
  CHECK (json_extract(provider_installation_ids_json, '$[0]') = plugin_installation_id),
  CHECK (notification_kind NOT GLOB '*[^a-z0-9._:-]*'
    AND length(notification_kind) BETWEEN 1 AND 128),
  CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  CHECK (expires_at > created_at),
  CHECK (provider_started_at >= created_at),
  CHECK (delete_after >= expires_at),
  CHECK (
    (state = 'pending'
      AND payload_key_id IS NOT NULL
      AND payload_key_id NOT GLOB '*[^a-zA-Z0-9._:-]*'
      AND length(payload_key_id) BETWEEN 1 AND 128
      AND payload_envelope_json IS NOT NULL
      AND json_valid(payload_envelope_json)
      AND length(payload_envelope_json) BETWEEN 1 AND 196608
      AND delivered_at IS NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'delivered'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND delivered_at IS NOT NULL
      AND canceled_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state IN ('canceled', 'expired')
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND canceled_at IS NOT NULL
      AND delivered_at IS NULL
      AND dead_lettered_at IS NULL) OR
    (state = 'dead_letter'
      AND payload_key_id IS NULL
      AND payload_envelope_json IS NULL
      AND dead_lettered_at IS NOT NULL
      AND delivered_at IS NULL
      AND canceled_at IS NULL)
  )
);
CREATE TABLE IF NOT EXISTS "oauth_client_consents" (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
  consent_version INTEGER DEFAULT 1, consent_generation INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, user_id, client_id)
);
CREATE TABLE IF NOT EXISTS "object_catalog" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  public_artifact_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  object_class TEXT NOT NULL CHECK (
    object_class IN (
      'admin_audit_detail',
      'event_log_detail',
      'pii_log_values',
      'webhook_delivery_payload',
      'operational_log_detail',
      'user_export',
      'user_import_input',
      'user_import_result',
      'admin_job_result',
      'directory_auth_evidence_export',
      'directory_auth_support_bundle',
      'approval_transport_detail',
      'dr_bundle'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE object_catalog_objects (
  id TEXT PRIMARY KEY
 NOT NULL
,
  catalog_id TEXT NOT NULL,
  representation TEXT NOT NULL CHECK (
    representation IN (
      'canonical_json',
      'csv_projection',
      'ndjson_projection',
      'zip_bundle'
    )
  ),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('single', 'manifest', 'chunk')),
  object_index INTEGER NOT NULL DEFAULT 0,
  bucket_binding TEXT NOT NULL CHECK (
    bucket_binding IN ('IMPORT_ARTIFACTS', 'EXPORT_ARTIFACTS', 'SENSITIVE_DETAILS')
  ),
  object_key TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  total_bytes INTEGER,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE,
  UNIQUE(catalog_id, representation, object_index)
);
CREATE TABLE oidc_scopes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  scope_type TEXT NOT NULL DEFAULT 'custom' CHECK (scope_type IN ('system', 'custom')),
  enabled INTEGER NOT NULL DEFAULT 1,
  localizations_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name)
);
INSERT INTO oidc_scopes VALUES('scope-openid-default','default','openid','OpenID','Sign in with an OpenID Connect identity.','system',1,NULL,0,0);
INSERT INTO oidc_scopes VALUES('scope-profile-default','default','profile','Profile','Access basic profile claims such as name and preferred username.','system',1,NULL,0,0);
INSERT INTO oidc_scopes VALUES('scope-email-default','default','email','Email','Access email address and email verification status.','system',1,NULL,0,0);
INSERT INTO oidc_scopes VALUES('scope-vc-attribute-default','default','vc.attribute','Verified attributes','Present and read verified attributes through the VC attribute-elevation service.','system',1,NULL,0,0);
CREATE TABLE operational_logs (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    subject_type TEXT NOT NULL,  -- Code expects: 'user', 'client', 'session'
    subject_id TEXT NOT NULL,    -- Code expects this name, not 'resource_id'
    actor_id TEXT NOT NULL,      -- Who performed the operation
    action TEXT NOT NULL,        -- 'user.suspend', 'user.lock', etc.
    reason_detail_encrypted TEXT,-- AES-GCM encrypted reason_detail
    encryption_key_version INTEGER NOT NULL DEFAULT 1, -- Code expects this column
    detail_object_catalog_id TEXT,
    request_id TEXT,             -- X-Request-ID header value
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, -- When this log should be deleted

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE org_domain_mappings (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Domain identification (hashed for privacy)
  -- Algorithm: HMAC-SHA256(lowercase(domain), secret_key)
  domain_hash TEXT NOT NULL,

  -- Key rotation support
  domain_hash_version INTEGER DEFAULT 1,

  -- Target organization
  org_id TEXT NOT NULL,                   -- Reference to organizations.id

  -- Auto-join settings
  auto_join_enabled INTEGER DEFAULT 1,    -- 0 = mapping exists but auto-join disabled
  membership_type TEXT NOT NULL DEFAULT 'member',  -- member, admin, owner
  auto_assign_role_id TEXT,               -- Optional: auto-assign this role on join

  -- Verification status
  verified INTEGER DEFAULT 0,             -- 1 = domain ownership verified (DNS TXT, etc.)

  -- Priority for multiple mappings
  priority INTEGER DEFAULT 0,             -- Higher = preferred when multiple match

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, verification_token TEXT, verification_status TEXT DEFAULT 'unverified', verification_expires_at INTEGER, verification_method TEXT,

  -- Constraints
  -- Allow same domain to map to multiple orgs with different versions
  UNIQUE(tenant_id, domain_hash, domain_hash_version, org_id)
);
CREATE TABLE organizations (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT,
  description TEXT,
  org_type TEXT NOT NULL DEFAULT 'enterprise',  -- distributor, enterprise, department
  parent_org_id TEXT REFERENCES organizations(id),
  plan TEXT DEFAULT 'free',  -- free, starter, professional, enterprise
  is_active INTEGER DEFAULT 1,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "passkeys" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default', aaguid TEXT, rp_id TEXT,
  UNIQUE(tenant_id, credential_id)
);
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE TABLE permission_change_audit (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    event_type TEXT NOT NULL,                  -- 'grant', 'revoke', 'modify'
    subject_id TEXT NOT NULL,
    resource TEXT,                             -- Resource affected (optional)
    relation TEXT,                             -- Relation affected (optional)
    permission TEXT,                           -- Permission affected (optional)
    timestamp INTEGER NOT NULL,                -- Event timestamp (Unix milliseconds)
    created_at INTEGER NOT NULL                -- Record creation time (Unix seconds)
);
CREATE TABLE permission_check_audit (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    subject_id TEXT NOT NULL,
    permission TEXT NOT NULL,                  -- Original permission string
    permission_json TEXT,                      -- Structured permission (if provided)
    allowed INTEGER NOT NULL,                  -- 1 = allowed, 0 = denied
    resolved_via_json TEXT NOT NULL,           -- JSON array: ["role", "rebac"]
    final_decision TEXT NOT NULL,              -- 'allow' | 'deny'
    reason TEXT,                               -- Denial reason (when denied)
    api_key_id TEXT,                           -- Which API key was used (if any)
    client_id TEXT,                            -- Client ID (from API key or token)
    checked_at INTEGER NOT NULL                -- Unix timestamp
);
CREATE TABLE plugin_account_metadata (
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  metadata_key TEXT NOT NULL,
  value_json TEXT NOT NULL
    CHECK (json_valid(value_json) AND length(value_json) BETWEEN 1 AND 16384),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, account_id, plugin_id, metadata_key),
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_id) BETWEEN 1 AND 256),
  CHECK (length(plugin_installation_id) BETWEEN 1 AND 256),
  CHECK (metadata_key NOT GLOB '*[^a-z0-9._-]*' AND length(metadata_key) BETWEEN 1 AND 64)
);
CREATE TABLE plugin_hook_outbox (
  outbox_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  plugin_installation_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version >= 1),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
  payload_class TEXT NOT NULL DEFAULT 'reference_v1' CHECK (payload_class = 'reference_v1'),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'locked', 'waiting_retry', 'succeeded', 'dead_letter', 'canceled')),
  attempt_no INTEGER NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  claim_owner TEXT,
  claim_token TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  succeeded_at INTEGER,
  dead_lettered_at INTEGER,
  canceled_at INTEGER,
  delete_after INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, plugin_installation_id, idempotency_key),
  CHECK (
    (status = 'locked' AND claim_owner IS NOT NULL AND claim_token IS NOT NULL
      AND lease_until IS NOT NULL AND lease_until > updated_at AND attempt_no >= 1) OR
    (status <> 'locked' AND claim_owner IS NULL AND claim_token IS NULL AND lease_until IS NULL)
  ),
  CHECK ((status = 'waiting_retry' AND next_attempt_at IS NOT NULL AND last_error_code IS NOT NULL)
    OR status <> 'waiting_retry'),
  CHECK ((status = 'queued' AND attempt_no = 0 AND next_attempt_at IS NULL) OR status <> 'queued'),
  CHECK ((status IN ('succeeded', 'dead_letter') AND attempt_no >= 1)
    OR status NOT IN ('succeeded', 'dead_letter')),
  CHECK ((status = 'succeeded' AND succeeded_at IS NOT NULL AND delete_after = succeeded_at + 604800) OR status <> 'succeeded'),
  CHECK ((status = 'dead_letter' AND dead_lettered_at IS NOT NULL AND delete_after = dead_lettered_at + 7776000) OR status <> 'dead_letter'),
  CHECK ((status = 'canceled' AND canceled_at IS NOT NULL) OR status <> 'canceled')
);
CREATE TABLE presentation_definitions (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    name TEXT NOT NULL,
    purpose TEXT,
    -- JSON: {"dc+sd-jwt": {...}, "mso_mdoc": {...}}
    format TEXT NOT NULL,
    -- JSON array of input descriptors
    input_descriptors TEXT NOT NULL,
    -- JSON for complex submission requirements
    submission_requirements TEXT,
    -- DCQL query (preferred for HAIP)
    dcql_query TEXT,
    -- Active status
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP)
);
CREATE TABLE profile_attribute_values (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  value_type TEXT NOT NULL,
  value_json TEXT,
  value_storage_ref TEXT,
  value_hash TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  purpose TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);
CREATE TABLE profiles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT 'person',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  locale TEXT,
  zoneinfo TEXT,
  display_name_ref TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, profile_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE
);
CREATE TABLE provisioning_assignment_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  rule_id TEXT,
  subject_id TEXT,
  account_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes_json TEXT,
  trace_ref TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE provisioning_assignment_ownership (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  assignment_type TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  source_id TEXT,
  ownership_policy TEXT NOT NULL DEFAULT 'source_owned',
  revoke_policy TEXT NOT NULL DEFAULT 'review',
  protected_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, assignment_type, assignment_id, source_id)
);
CREATE TABLE provisioning_assignment_rules (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  rule_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE provisioning_revocation_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  source_event_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE refresh_token_shard_configs (
  id TEXT PRIMARY KEY
 NOT NULL
,                -- UUID
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,                     -- NULL = global config
  generation INTEGER NOT NULL,
  shard_count INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,      -- When this config was activated (ms)
  deprecated_at INTEGER,              -- When this config was deprecated (ms)
  created_by TEXT,                    -- Admin user who created this config
  notes TEXT,                         -- Human-readable notes

  UNIQUE(tenant_id, client_id, generation)
);
CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  -- Object type this definition applies to
  object_type TEXT NOT NULL,        -- 'document', 'folder', 'org', etc.
  -- Relation name being defined
  relation_name TEXT NOT NULL,      -- 'viewer', 'editor', 'owner', etc.
  -- Relation composition rule (JSON)
  definition_json TEXT NOT NULL,
  -- Description for documentation
  description TEXT,
  -- Evaluation priority (higher = evaluated first)
  priority INTEGER DEFAULT 0,
  -- Whether this definition is active
  is_active INTEGER DEFAULT 1,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  -- Ancestor (source) entity
  ancestor_type TEXT NOT NULL,      -- 'subject', 'org', 'group'
  ancestor_id TEXT NOT NULL,
  -- Descendant (target) entity
  descendant_type TEXT NOT NULL,    -- 'document', 'folder', 'org', 'resource'
  descendant_id TEXT NOT NULL,
  -- Computed relation (derived from relationship chain)
  relation TEXT NOT NULL,           -- 'viewer', 'editor', 'owner'
  -- Path information
  depth INTEGER NOT NULL,           -- Number of hops (0 = direct)
  path_json TEXT,                   -- JSON array of relationship IDs in the path
  -- Computed metadata
  effective_permission TEXT,        -- Most restrictive permission in path
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE relationships (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  relationship_type TEXT NOT NULL,  -- parent_child, guardian, delegate, manager, reseller_of
  from_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  from_id TEXT NOT NULL,  -- subject_id or org_id
  to_type TEXT NOT NULL DEFAULT 'subject',  -- subject, org (future)
  to_id TEXT NOT NULL,  -- subject_id or org_id
  permission_level TEXT NOT NULL DEFAULT 'full',  -- full, limited, read_only
  expires_at INTEGER,  -- Optional expiration (UNIX seconds)
  is_bidirectional INTEGER DEFAULT 0,  -- Phase 1: always 0
  metadata_json TEXT,  -- Additional constraints, notes, etc.
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, evidence_type TEXT DEFAULT 'manual', evidence_ref TEXT);
CREATE TABLE resource_permissions (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Subject (who has the permission)
  subject_type TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'role' | 'org'
  subject_id TEXT NOT NULL,                   -- user_id, role_id, or org_id

  -- Resource (what is being accessed)
  resource_type TEXT NOT NULL,                -- e.g., 'documents', 'projects'
  resource_id TEXT NOT NULL,                  -- e.g., 'doc_123', 'proj_456'

  -- Actions allowed (JSON array)
  -- Example: ["read", "write", "delete"]
  actions_json TEXT NOT NULL,

  -- Optional condition for permission (JSON)
  -- Example: {"time_restricted": true, "hours": [9, 17]}
  condition_json TEXT,

  -- Expiration (UNIX seconds)
  -- NULL = no expiration
  -- Evaluated at token generation time only
  expires_at INTEGER,

  -- Status
  is_active INTEGER DEFAULT 1,

  -- Audit fields
  granted_by TEXT,                            -- Admin or system that granted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  -- Same subject can have only one permission entry per resource
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);
CREATE TABLE role_assignment_rules (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target role (reference only, no FK for flexibility)
  role_id TEXT NOT NULL,

  -- Scope for assigned role
  scope_type TEXT NOT NULL DEFAULT 'global',  -- global, org, resource
  scope_target TEXT NOT NULL DEFAULT '',      -- e.g., 'org:org_123' or '' for global

  -- Conditions (JSON format)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "email_domain_hash", "operator": "eq", "value": "abc123..."},
  --   {"field": "idp_claim", "claim_path": "groups", "operator": "contains", "value": "admin"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "assign_role", "role_id": "role_org_admin", "scope_type": "org", "scope_target": "auto"},
  --   {"type": "join_org", "org_id": "auto"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
);
CREATE TABLE roles (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  role_type TEXT NOT NULL DEFAULT 'custom',
  hierarchy_level INTEGER DEFAULT 0,
  is_assignable INTEGER DEFAULT 1,
  parent_role_id TEXT REFERENCES roles(id),
  display_name TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER, external_id TEXT,
  UNIQUE(tenant_id, name)
);
CREATE TABLE saml_attribute_presets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  applies_to TEXT NOT NULL DEFAULT 'sp_attribute_release',
  profile TEXT NOT NULL DEFAULT 'custom',
  stability TEXT NOT NULL DEFAULT 'custom',
  application_mode TEXT NOT NULL DEFAULT 'clone_edit',
  attribute_release_policy_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, label)
);
CREATE TABLE IF NOT EXISTS "screens" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN (
      'registration',
      'profile_completion',
      'login',
      'consent',
      'code_input',
      'account',
      'custom'
    )
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  settings_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, screen_key)
);
INSERT INTO screens VALUES('screen-registration-default','default','registration','Registration','Default registration screen.','registration','[{"field":"heading.registration","label":"Create your account","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Create Account with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10}]','{"en":{"fields":{"heading.registration-0":{"label":"Create your account"}}},"ja":{"fields":{"heading.registration-0":{"label":"アカウントを作成"}}},"es":{"fields":{"heading.registration-0":{"label":"Crea tu cuenta"}}},"pt":{"fields":{"heading.registration-0":{"label":"Crie sua conta"}}},"fr":{"fields":{"heading.registration-0":{"label":"Créez votre compte"}}},"de":{"fields":{"heading.registration-0":{"label":"Konto erstellen"}}},"ko":{"fields":{"heading.registration-0":{"label":"계정 만들기"}}},"ru":{"fields":{"heading.registration-0":{"label":"Создайте учетную запись"}}},"id":{"fields":{"heading.registration-0":{"label":"Buat akun Anda"}}},"zh-CN":{"fields":{"heading.registration-0":{"label":"创建你的账户"}}},"zh-TW":{"fields":{"heading.registration-0":{"label":"建立你的帳戶"}}}}','{"canvas_layout":"narrow"}',1,1,0,0);
INSERT INTO screens VALUES('screen-profile-completion-default','default','profile_completion','Profile completion','Default profile completion screen.','profile_completion','[{"field":"name","label":"Name","required":true},{"field":"preferred_username","label":"Preferred username","required":false}]',NULL,'{"canvas_layout":"narrow"}',1,1,0,0);
INSERT INTO screens VALUES('screen-login-default','default','login','Login','Default login screen.','login','[{"field":"heading.login","label":"Sign in","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Sign in with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10},{"field":"divider.or","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"mail_otp"},"order":20},{"field":"auth.mail_otp","label":"Send code by email","required":false,"block_type":"auth_widget","auth_method":"mail_otp","order":30},{"field":"auth.totp","label":"Sign in with authenticator app","required":false,"block_type":"auth_widget","auth_method":"totp","order":35},{"field":"divider.other_accounts","label":"Continue with another account","required":false,"block_type":"divider","text":"Continue with another account","display_condition":{"mode":"feature_enabled","feature":"external_idp"},"order":40},{"field":"auth.external_idp","label":"Ext. IdP","required":false,"block_type":"auth_widget","auth_method":"external_idp","external_idp_show_action_text":false,"order":50},{"field":"divider.directory_password","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"directory_password"},"order":55},{"field":"auth.directory_password","label":"Sign in with directory password","required":false,"block_type":"auth_widget","auth_method":"directory_password","order":60}]','{"en":{"fields":{"heading.login-0":{"label":"Sign in"}}},"ja":{"fields":{"heading.login-0":{"label":"ログイン"}}},"es":{"fields":{"heading.login-0":{"label":"Iniciar sesión"}}},"pt":{"fields":{"heading.login-0":{"label":"Entrar"}}},"fr":{"fields":{"heading.login-0":{"label":"Se connecter"}}},"de":{"fields":{"heading.login-0":{"label":"Anmelden"}}},"ko":{"fields":{"heading.login-0":{"label":"로그인"}}},"ru":{"fields":{"heading.login-0":{"label":"Войти"}}},"id":{"fields":{"heading.login-0":{"label":"Masuk"}}},"zh-CN":{"fields":{"heading.login-0":{"label":"登录"}}},"zh-TW":{"fields":{"heading.login-0":{"label":"登入"}}}}','{"canvas_layout":"narrow"}',1,1,0,0);
INSERT INTO screens VALUES('screen-code-input-default','default','code_input','Code input','Default code input screen.','code_input','[{"field":"heading.code_input","label":"Enter verification code","required":false,"block_type":"heading","order":0},{"field":"auth.code_input","label":"Authentication code","required":true,"block_type":"code_input_widget","auth_method":"mail_otp","code_input_mode":"auto","text":"Enter the code from your email or authenticator app.","order":10}]','{"en":{"fields":{"heading.code_input-0":{"label":"Enter verification code"}}},"ja":{"fields":{"heading.code_input-0":{"label":"認証コードを入力"}}},"es":{"fields":{"heading.code_input-0":{"label":"Introduce el código de verificación"}}},"pt":{"fields":{"heading.code_input-0":{"label":"Insira o código de verificação"}}},"fr":{"fields":{"heading.code_input-0":{"label":"Saisissez le code de vérification"}}},"de":{"fields":{"heading.code_input-0":{"label":"Bestätigungscode eingeben"}}},"ko":{"fields":{"heading.code_input-0":{"label":"인증 코드를 입력하세요"}}},"ru":{"fields":{"heading.code_input-0":{"label":"Введите код подтверждения"}}},"id":{"fields":{"heading.code_input-0":{"label":"Masukkan kode verifikasi"}}},"zh-CN":{"fields":{"heading.code_input-0":{"label":"输入验证码"}}},"zh-TW":{"fields":{"heading.code_input-0":{"label":"輸入驗證碼"}}}}','{"canvas_layout":"narrow"}',1,1,0,0);
CREATE TABLE security_alerts (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN (
        'brute_force',
        'credential_stuffing',
        'suspicious_login',
        'impossible_travel',
        'account_takeover',
        'mfa_bypass_attempt',
        'token_abuse',
        'rate_limit_exceeded',
        'config_change',
        'privilege_escalation',
        'data_exfiltration',
        'other'
    )),
    severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
    title TEXT NOT NULL,
    description TEXT,
    source_ip TEXT,
    user_id TEXT,
    client_id TEXT,
    metadata TEXT, -- JSON string for additional context
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    acknowledged_at INTEGER,
    acknowledged_by TEXT,
    resolved_at INTEGER,
    resolved_by TEXT,

    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE TABLE security_threats (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- credential_compromise, attack_pattern, vulnerability, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  status TEXT NOT NULL DEFAULT 'active',  -- active, investigating, mitigated, resolved
  title TEXT NOT NULL,          -- Short title
  description TEXT,             -- Detailed description
  source TEXT,                  -- Detection source (system, external, manual)
  affected_resources TEXT,      -- JSON: List of affected resources
  indicators TEXT,              -- JSON: Indicators of compromise (IOCs)
  metadata TEXT,                -- JSON: Additional context
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  detected_at TEXT NOT NULL,    -- When threat was detected
  mitigated_at TEXT             -- When threat was mitigated
);
CREATE TABLE sensitive_detail_chunk_index (
  catalog_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  object_class TEXT NOT NULL,
  bucket_binding TEXT NOT NULL CHECK (bucket_binding IN ('SENSITIVE_DETAILS')),
  object_key TEXT NOT NULL,
  content_encoding TEXT NOT NULL DEFAULT 'gzip' CHECK (content_encoding IN ('gzip', 'none')),
  line_number INTEGER NOT NULL,
  byte_offset INTEGER,
  byte_length INTEGER,
  key_version INTEGER NOT NULL DEFAULT 1,
  checksum_sha256 TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY (catalog_id) REFERENCES object_catalog(id) ON DELETE CASCADE
);
CREATE TABLE service_group_audit (
 id TEXT PRIMARY KEY
 NOT NULL
, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 rule_version INTEGER NOT NULL, generation INTEGER NOT NULL,
 event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE service_group_catalog (
 tenant_id TEXT PRIMARY KEY
 NOT NULL
, revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL,
 updated_at INTEGER NOT NULL, write_token TEXT NOT NULL
);
CREATE TABLE service_group_epoch (
 tenant_id TEXT PRIMARY KEY
 NOT NULL
, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE service_group_write_boundaries (
 id TEXT PRIMARY KEY
 NOT NULL
, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 operation TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "sessions" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  external_provider_id TEXT,
  external_provider_sub TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default', external_provider_sid TEXT,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE TABLE settings_history (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Category (oauth, rate_limit, logout, webhook, feature_flags, etc.)
  category TEXT NOT NULL,

  -- Version number (auto-incremented per tenant+category)
  version INTEGER NOT NULL,

  -- Full configuration snapshot (JSON)
  -- This allows complete restoration without dependencies
  snapshot TEXT NOT NULL,

  -- Change summary (JSON)
  -- { "added": [...], "removed": [...], "modified": [...] }
  changes TEXT NOT NULL,

  -- Actor who made the change
  actor_id TEXT,           -- User ID or 'system'
  actor_type TEXT,         -- 'user', 'admin', 'system', 'api'

  -- Change metadata
  change_reason TEXT,      -- Optional reason for the change
  change_source TEXT,      -- 'admin_api', 'settings_ui', 'migration', 'rollback'

  -- Timestamps
  created_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, category, version)
);
CREATE TABLE sign_in_confirmation_policies (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'login', -- 'login' for initial implementation
  mode TEXT NOT NULL DEFAULT 'disabled', -- 'disabled'|'first_time'|'every_time'
  remember_duration_days INTEGER NOT NULL DEFAULT 365,
  show_application_context INTEGER NOT NULL DEFAULT 1,
  show_tenant_context INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, trigger_type)
);
CREATE TABLE status_lists (
    internal_id TEXT PRIMARY KEY
 NOT NULL
,
    public_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    -- Purpose: 'revocation' | 'suspension'
    purpose TEXT NOT NULL DEFAULT 'revocation',
    -- Bitstring of status values (base64url encoded)
    encoded_list TEXT NOT NULL,
    -- Current index for new credentials
    current_index INTEGER DEFAULT 0,
    -- Total capacity
    capacity INTEGER DEFAULT 131072,
    used_count INTEGER DEFAULT 0,
    state TEXT DEFAULT 'active',
    sealed_at TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE (tenant_id, public_id)
);
CREATE TABLE structured_attribute_values (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  catalog_entry_id TEXT NOT NULL,
  canonical_json TEXT NOT NULL,
  projected_index_json TEXT,
  classification TEXT NOT NULL DEFAULT 'internal',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE subject_account_links (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'primary',
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (tenant_id, subject_id, account_id, link_type),
  FOREIGN KEY (subject_id) REFERENCES identity_subjects(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES identity_accounts(id) ON DELETE CASCADE
);
CREATE TABLE subject_lifecycle_timeline_events (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT,
  account_id TEXT,
  event_type TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  summary_json TEXT,
  event_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE support_operation_actions (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  cohort_id TEXT NOT NULL,
  resource TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('approval_required', 'approved', 'running', 'completed', 'failed', 'cancelled')
  ),
  reason TEXT NOT NULL,
  support_case_id TEXT,
  approval_request_id TEXT,
  job_id TEXT,
  result_summary_json TEXT,
  requested_by TEXT NOT NULL,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE
);
CREATE TABLE support_operation_cohort_targets (
  id TEXT PRIMARY KEY
 NOT NULL
,
  cohort_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_hash TEXT,
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (cohort_id) REFERENCES support_operation_cohorts(id) ON DELETE CASCADE,
  UNIQUE(cohort_id, target_id)
);
CREATE TABLE support_operation_cohorts (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  resource TEXT NOT NULL,
  intended_action TEXT NOT NULL,
  selector_json TEXT NOT NULL,
  selector_hash TEXT NOT NULL,
  matched_count INTEGER NOT NULL,
  actionable_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  blocked_summary_json TEXT,
  snapshot_status TEXT NOT NULL DEFAULT 'completed' CHECK (
    snapshot_status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  snapshot_job_id TEXT,
  snapshot_error TEXT,
  risk_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  support_case_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE suspicious_activities (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,           -- brute_force, credential_stuffing, anomalous_login, etc.
  severity TEXT NOT NULL,       -- critical, high, medium, low, info
  user_id TEXT,                 -- Associated user (nullable for pre-auth events)
  client_id TEXT,               -- Associated OAuth client
  source_ip TEXT,               -- Source IP address
  user_agent TEXT,              -- User agent string
  description TEXT,             -- Human-readable description
  metadata TEXT,                -- JSON: Additional context data
  created_at TEXT NOT NULL,     -- When detected
  resolved_at TEXT              -- When resolved/dismissed
);
CREATE TABLE tenant_consent_requirements (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  statement_id TEXT NOT NULL,
  is_required INTEGER NOT NULL DEFAULT 0,
  min_version TEXT,
  enforcement TEXT NOT NULL DEFAULT 'block',
  show_deletion_link INTEGER NOT NULL DEFAULT 0,
  deletion_url TEXT,
  conditional_rules_json TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, statement_id)
);
CREATE TABLE tenant_database_probe_results (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  shard_group TEXT NOT NULL DEFAULT 'default',
  shard_index INTEGER NOT NULL DEFAULT 0,
  generation INTEGER,
  probe_kind TEXT NOT NULL CHECK (probe_kind IN ('dry_run', 'write_read_delete')),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'skipped')),
  latency_ms INTEGER,
  binding_ref TEXT,
  connection_ref TEXT,
  provider TEXT,
  schema_version INTEGER,
  error_class TEXT,
  error_message TEXT,
  metadata_json TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE tenant_domain_mappings (
  id                      TEXT PRIMARY KEY
 NOT NULL
,
  domain_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  tenant_id               TEXT NOT NULL,
  priority                INTEGER NOT NULL DEFAULT 0,
  is_active               INTEGER NOT NULL DEFAULT 1,
  active_domain_hash      TEXT,
  verified                INTEGER NOT NULL DEFAULT 0,
  verification_token      TEXT,
  verification_expires_at INTEGER,
  created_by              TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE TABLE tenant_invitations (
  id             TEXT PRIMARY KEY
 NOT NULL
,
  token          TEXT NOT NULL UNIQUE,         -- 256-bit entropy token
  tenant_id      TEXT NOT NULL,
  invited_email  TEXT,                         -- NULL=anyone, NON-NULL=specific email only
  invited_by     TEXT NOT NULL,                -- Admin user ID who created the invitation
  role_id        TEXT,                         -- Optional: auto-assign this role on signup
  org_id         TEXT,                         -- Optional: auto-assign to this org on signup
  max_uses       INTEGER NOT NULL DEFAULT 1,   -- -1=unlimited
  use_count      INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE TABLE tenant_placement_migration_captures (
  operation_id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  migration_generation INTEGER NOT NULL CHECK (migration_generation >= 1),
  capture_state TEXT NOT NULL DEFAULT 'capturing'
    CHECK (capture_state IN ('capturing', 'write_fenced', 'cutover_committed', 'canceled')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  installed_at INTEGER NOT NULL,
  write_fenced_at INTEGER,
  cutover_committed_at INTEGER,
  canceled_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((capture_state = 'write_fenced' AND write_fenced_at IS NOT NULL)
    OR capture_state <> 'write_fenced'),
  CHECK ((capture_state = 'cutover_committed' AND cutover_committed_at IS NOT NULL)
    OR capture_state <> 'cutover_committed'),
  CHECK ((capture_state = 'canceled' AND canceled_at IS NOT NULL)
    OR capture_state <> 'canceled')
);
CREATE TABLE tenant_placement_migration_outbox (
  source_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (
    length(table_name) BETWEEN 1 AND 128 AND table_name NOT GLOB '*[^a-z0-9_]*'
  ),
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN ('upsert', 'delete')),
  mutation_key_json TEXT NOT NULL CHECK (json_valid(mutation_key_json)),
  row_json TEXT CHECK (row_json IS NULL OR json_valid(row_json)),
  capture_fencing_token INTEGER NOT NULL CHECK (capture_fencing_token >= 1),
  delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'applied')),
  applied_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES tenant_placement_migration_captures(operation_id),
  CHECK ((mutation_kind = 'upsert' AND row_json IS NOT NULL) OR
         (mutation_kind = 'delete' AND row_json IS NULL)),
  CHECK ((delivery_state = 'applied' AND applied_at IS NOT NULL) OR
         (delivery_state = 'pending' AND applied_at IS NULL))
);
CREATE TABLE tenant_vanity_domains (
  id                             TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id                      TEXT NOT NULL,
  hostname                       TEXT NOT NULL,
  is_active                      INTEGER NOT NULL DEFAULT 1,
  active_hostname                TEXT,
  is_primary                     INTEGER NOT NULL DEFAULT 0,
  primary_active_tenant_key      TEXT,
  status                         TEXT NOT NULL DEFAULT 'pending',
  cloudflare_zone_id             TEXT,
  cloudflare_custom_hostname_id  TEXT,
  ssl_status                     TEXT,
  ownership_status               TEXT,
  validation_method              TEXT,
  validation_records_json        TEXT,
  last_sync_at                   INTEGER,
  created_by                     TEXT,
  created_at                     INTEGER NOT NULL,
  updated_at                     INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY
 NOT NULL
,           -- slug format: ^[a-z0-9-]+$, max 63chars
  tenant_code TEXT NOT NULL UNIQUE,       -- manual-entry/discovery code (globally unique)
  tenant_key  TEXT NOT NULL UNIQUE,       -- opaque key for logging/storage object paths
  name        TEXT NOT NULL,              -- display name
  description TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0, -- default tenant (only one)
  default_tenant_guard TEXT,              -- 'default' when is_default=1, NULL otherwise
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
, lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN (
    'provisioning',
    'active',
    'suspended',
    'frozen',
    'migration_read_only',
    'deleting',
    'deleted',
    'restore_pending',
    'restore_validating'
  )), isolation_policy TEXT NOT NULL DEFAULT 'tenant_exclusive'
  CHECK (isolation_policy IN ('shared_pool', 'tenant_exclusive')));
INSERT INTO tenants VALUES('default','default','t_' || lower(hex(randomblob(18))),'Default',NULL,1,'default',__AUTHRIM_NOW_EPOCH_SECONDS__,__AUTHRIM_NOW_EPOCH_SECONDS__,'active','tenant_exclusive');
CREATE TABLE token_claim_rules (
  -- Primary key
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Rule identification
  name TEXT NOT NULL,
  description TEXT,

  -- Target token type
  token_type TEXT NOT NULL DEFAULT 'access',  -- 'access' | 'id' | 'both'

  -- Conditions (JSON format, same structure as role_assignment_rules)
  -- Example: {"type": "and", "conditions": [
  --   {"field": "has_role", "operator": "contains", "value": "premium_user"},
  --   {"field": "org_type", "operator": "eq", "value": "enterprise"}
  -- ]}
  conditions_json TEXT NOT NULL,

  -- Actions (JSON format)
  -- Example: [
  --   {"type": "add_claim", "claim_name": "tier", "claim_value": "premium"},
  --   {"type": "add_claim_template", "claim_name": "greeting", "template": "Hello {{user_type}}"},
  --   {"type": "copy_from_context", "claim_name": "org", "context_field": "org_id"}
  -- ]
  actions_json TEXT NOT NULL,

  -- Priority and control
  priority INTEGER NOT NULL DEFAULT 0,    -- Higher = evaluated first (DESC order)
  stop_processing INTEGER DEFAULT 0,      -- 1 = stop evaluating further rules after match
  is_active INTEGER DEFAULT 1,            -- 0 = disabled

  -- Validity period (optional, UNIX seconds)
  valid_from INTEGER,                     -- NULL = no start restriction
  valid_until INTEGER,                    -- NULL = no end restriction

  -- Audit fields
  created_by TEXT,                        -- Admin user ID who created
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(tenant_id, name)
);
CREATE TABLE totp_backup_codes (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  credential_id TEXT,
  code_hash TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  UNIQUE (tenant_id, user_id, code_hash)
);
CREATE TABLE totp_credentials (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  secret_key_version INTEGER NOT NULL DEFAULT 1,
  label TEXT,
  algorithm TEXT NOT NULL DEFAULT 'SHA1',
  digits INTEGER NOT NULL DEFAULT 6,
  period INTEGER NOT NULL DEFAULT 30,
  window INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  last_used_time_step INTEGER,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_used_at INTEGER,
  CHECK (algorithm IN ('SHA1', 'SHA256')),
  CHECK (digits IN (6, 8)),
  CHECK (period BETWEEN 15 AND 300),
  CHECK (window BETWEEN 0 AND 2),
  CHECK (status IN ('pending', 'active', 'disabled'))
);
CREATE TABLE trusted_issuers (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    issuer_did TEXT NOT NULL,
    display_name TEXT,
    -- JSON array of accepted Verifiable Credential Types
    credential_types TEXT,
    -- Trust level: 'standard' | 'high' (HAIP-compliant)
    trust_level TEXT DEFAULT 'standard',
    -- JWKS URI for issuer public keys
    jwks_uri TEXT,
    -- Issuer status: 'active' | 'suspended' | 'revoked'
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    updated_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    UNIQUE(tenant_id, issuer_did)
);
CREATE TABLE upstream_providers (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,                    -- Display name: "Google", "GitHub"
  provider_type TEXT NOT NULL,           -- 'oidc' | 'oauth2'
  enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 0,            -- Display order (lower = higher priority)

  -- OIDC/OAuth2 endpoints
  issuer TEXT,                           -- OIDC issuer URL (for discovery)
  client_id TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL, -- Encrypted with RP_TOKEN_ENCRYPTION_KEY
  authorization_endpoint TEXT,           -- Override for non-standard providers
  token_endpoint TEXT,
  userinfo_endpoint TEXT,
  jwks_uri TEXT,
  scopes TEXT NOT NULL DEFAULT 'openid email profile', -- Space-separated

  -- Configuration
  attribute_mapping TEXT DEFAULT '{}',   -- JSON: {"sub": "sub", "email": "email"}
  auto_link_email INTEGER DEFAULT 1,     -- Enable email-based identity stitching
  jit_provisioning INTEGER DEFAULT 1,    -- Create user on first login
  require_email_verified INTEGER DEFAULT 1, -- Only link if email is verified

  -- Provider-specific settings
  provider_quirks TEXT DEFAULT '{}',     -- JSON for provider-specific handling

  -- UI customization
  icon_url TEXT,                         -- Provider icon for login button
  icon_name TEXT,                        -- Built-in icon name for login button
  button_color TEXT,                     -- Brand color for login button (hex, light theme)
  button_color_dark TEXT,                -- Brand color for login button (hex, dark theme)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
, slug TEXT, token_endpoint_auth_method TEXT DEFAULT 'client_secret_post', always_fetch_userinfo INTEGER DEFAULT 0, enable_sso INTEGER NOT NULL DEFAULT 1, use_request_object INTEGER DEFAULT 0, request_object_signing_alg TEXT, private_key_jwk_encrypted TEXT, public_key_jwk TEXT, profile_update_fields TEXT
  CHECK (
    profile_update_fields IS NULL OR (
      json_valid(profile_update_fields)
      AND json_type(profile_update_fields) = 'array'
    )
  ));
CREATE TABLE IF NOT EXISTS "user_roles" (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "user_token_families" (
  jti TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
CREATE TABLE user_verified_attributes (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    -- Attribute name: 'age_over_18', 'country', 'organization', etc.
    attribute_name TEXT NOT NULL,
    -- Attribute value: 'true', 'JP', 'Acme Corp', etc.
    attribute_value TEXT NOT NULL,
    -- Source type: 'vc' | 'saml' | 'oidc' | 'manual'
    source_type TEXT NOT NULL DEFAULT 'vc',
    -- Issuer DID (for VC-sourced attributes)
    issuer_did TEXT,
    -- Reference to verification record
    verification_id TEXT REFERENCES attribute_verifications(id),
    verified_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT, revalidate_after INTEGER, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    -- Each user can have only one value per attribute
    UNIQUE(tenant_id, user_id, attribute_name)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY
 NOT NULL
,
  email TEXT UNIQUE NOT NULL,
  email_verified INTEGER DEFAULT 0,
  name TEXT,
  given_name TEXT,
  family_name TEXT,
  middle_name TEXT,
  nickname TEXT,
  preferred_username TEXT,
  profile TEXT,
  picture TEXT,
  website TEXT,
  gender TEXT,
  birthdate TEXT,
  zoneinfo TEXT,
  locale TEXT,
  phone_number TEXT,
  phone_number_verified INTEGER DEFAULT 0,
  address_json TEXT,
  custom_attributes_json TEXT,
  parent_user_id TEXT REFERENCES users(id),
  identity_provider_id TEXT REFERENCES identity_providers(id),
  -- Password authentication fields (optional, disabled by default)
  password_hash TEXT,
  password_changed_at INTEGER,
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until INTEGER,
  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, tenant_id TEXT NOT NULL DEFAULT 'default', user_type TEXT NOT NULL DEFAULT 'end_user', status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')), suspended_at INTEGER, suspended_until INTEGER, locked_at INTEGER);
CREATE TABLE users_core (
  -- Primary key (UUID, same as users_pii.id)
  id TEXT PRIMARY KEY
 NOT NULL
,

  -- Multi-tenant support
  tenant_id TEXT NOT NULL DEFAULT 'default',

  -- Verification status (not PII - just flags)
  email_verified INTEGER DEFAULT 0,
  phone_number_verified INTEGER DEFAULT 0,

  -- Blind index for domain-based role assignment (Phase 8)
  -- Stored as hash, cannot be reversed to original domain
  email_domain_hash TEXT,

  -- Authentication
  password_hash TEXT,

  -- Soft delete (1 = active, 0 = deleted)
  is_active INTEGER DEFAULT 1,

  -- User type: end_user | admin | m2m
  -- m2m is reserved for non-human service principals represented as user rows.
  -- Many OAuth client_credentials actors are modeled as OAuth clients instead.
  user_type TEXT NOT NULL DEFAULT 'end_user',

  -- PII partition info
  -- Which database contains this user's PII (e.g., 'default', 'eu', 'tenant-acme')
  pii_partition TEXT NOT NULL DEFAULT 'default',

  -- PII write status
  -- none: No PII (M2M clients)
  -- pending: Core created, PII write in progress
  -- active: Both Core and PII created successfully
  -- failed: PII write failed (requires retry via Admin UI)
  -- deleted: PII deleted (GDPR), tombstone created
  pii_status TEXT NOT NULL DEFAULT 'pending',

  -- Timestamps
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER
, email_domain_hash_version INTEGER DEFAULT 1, external_id TEXT DEFAULT NULL,
  -- Operational access control only. Keep separate from future lifecycle_state.
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'locked')),
  -- Account lifecycle stage. Keep separate from status and user_type.
  -- Values: invited, pending_verification, provisioning, incomplete,
  -- active, dormant, archived, deprovisioned.
  lifecycle_state TEXT DEFAULT 'active' CHECK (
    lifecycle_state IN (
      'invited',
      'pending_verification',
      'provisioning',
      'incomplete',
      'active',
      'dormant',
      'archived',
      'deprovisioned'
    )
  ),
  suspended_at INTEGER,
  suspended_until INTEGER,
  locked_at INTEGER,
  locked_until INTEGER
);
CREATE TABLE value_provenance (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  owner_table TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_record_id TEXT,
  source_field_ref TEXT,
  source_authority_contract_id TEXT,
  observed_at INTEGER NOT NULL,
  confidence_score INTEGER,
  provenance_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE vp_requests (
    id TEXT PRIMARY KEY
 NOT NULL
,
    tenant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    -- Nonce for replay protection (single-use, enforced by DO)
    nonce TEXT NOT NULL,
    state TEXT,
    -- Reference to presentation definition (optional, can use inline)
    presentation_definition_id TEXT REFERENCES presentation_definitions(id),
    response_uri TEXT NOT NULL,
    -- Response mode: 'direct_post' | 'direct_post.jwt' | 'fragment' | 'query'
    response_mode TEXT DEFAULT 'direct_post',
    -- Request status: 'pending' | 'submitted' | 'verified' | 'failed' | 'expired'
    status TEXT DEFAULT 'pending',
    -- Error information if failed
    error_code TEXT,
    error_description TEXT,
    created_at TEXT DEFAULT (CURRENT_TIMESTAMP),
    expires_at TEXT NOT NULL,
    verified_at TEXT
);
CREATE TABLE web_origin_registry (
  id TEXT PRIMARY KEY
 NOT NULL
,
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
CREATE TABLE webhook_configs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  client_id TEXT,
  scope TEXT NOT NULL DEFAULT 'tenant',
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret_encrypted TEXT,
  headers TEXT,
  retry_policy TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT,
  last_failure_at TEXT
, payload_fields TEXT NOT NULL DEFAULT '[]', registration_states TEXT NOT NULL DEFAULT '[]');
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY
 NOT NULL
,
  webhook_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed', 'retrying')),
  status_code INTEGER,
  request_headers TEXT,
  request_body TEXT,
  response_body TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  detail_object_catalog_id TEXT,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);
CREATE TABLE webhook_delivery_logs (
  id TEXT PRIMARY KEY
 NOT NULL
,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  status_code INTEGER,
  error_message TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (webhook_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
);
CREATE TABLE tenant_backup_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('capturing', 'sealed', 'invalid')),
  tenant_key TEXT CHECK (tenant_key IS NULL OR length(tenant_key) > 0)
);
CREATE TABLE tenant_backup_preimages (
  snapshot_id TEXT NOT NULL REFERENCES tenant_backup_snapshots(id) ON DELETE CASCADE,
  source_table TEXT NOT NULL,
  record_key TEXT NOT NULL,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  row_json TEXT, row_partition TEXT
  CHECK (
    row_partition IS NULL OR (
      typeof(row_partition) = 'text'
      AND length(row_partition) BETWEEN 1 AND 64
    )
  ),
  PRIMARY KEY (snapshot_id, source_table, record_key),
  CHECK ((present = 0 AND row_json IS NULL) OR (present = 1 AND row_json IS NOT NULL))
);
CREATE TABLE tenant_backup_restore_targets (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK(length(plan_digest)=64),
  seed_fingerprint TEXT NOT NULL CHECK(length(seed_fingerprint)=64),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK(fencing_token>0),
  lease_expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('loading','sealed','invalid'))
);
CREATE TABLE oauth_client_consent_revocations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, client_id)
);
CREATE TABLE tenant_invitation_redemptions (
  id            TEXT PRIMARY KEY NOT NULL,
  tenant_id     TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  holder        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'applied')),
  user_id       TEXT,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE TABLE IF NOT EXISTS "role_assignments" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS "subject_org_membership" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_type TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE support_ops_account_result_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(receipt_id) = 64 AND receipt_id NOT GLOB '*[^0-9a-f]*'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 512),
  action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 512),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 512),
  legacy_user_id TEXT NOT NULL CHECK (length(legacy_user_id) BETWEEN 1 AND 512),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 512),
  source_version_ms INTEGER NOT NULL
    CHECK (typeof(source_version_ms) = 'integer' AND source_version_ms BETWEEN 1 AND 9007199254740991),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  request_hash TEXT NOT NULL
    CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  attempt_token TEXT NOT NULL CHECK (length(attempt_token) = 36),
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  created_at_ms INTEGER NOT NULL
    CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991),
  acknowledged_at_ms INTEGER
    CHECK (acknowledged_at_ms IS NULL OR
      (typeof(acknowledged_at_ms) = 'integer' AND acknowledged_at_ms BETWEEN created_at_ms AND 9007199254740991)),
  delete_after_ms INTEGER
    CHECK (delete_after_ms IS NULL OR
      (typeof(delete_after_ms) = 'integer' AND delete_after_ms BETWEEN acknowledged_at_ms AND 9007199254740991)),
  CHECK ((acknowledged_at_ms IS NULL AND delete_after_ms IS NULL) OR
    (acknowledged_at_ms IS NOT NULL AND delete_after_ms IS NOT NULL)),
  UNIQUE (tenant_id, action_id, account_id, operation_id, source_version_ms)
);
CREATE TABLE provisioning_revocation_receipts (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  subject_id TEXT,
  source_event_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)
) STRICT;
CREATE TABLE log_iceberg_core_publications (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  storage_generation TEXT NOT NULL,
  record_id TEXT NOT NULL CHECK(length(record_id)=64),
  source_dataset TEXT NOT NULL,
  payload_hmac TEXT NOT NULL CHECK(length(payload_hmac)=64),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  source_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','committed','published','aborted')),
  body_prepared INTEGER NOT NULL DEFAULT 0 CHECK(body_prepared IN (0,1)),
  admission_expires_at INTEGER NOT NULL DEFAULT 0 CHECK(admission_expires_at>=0),
  admission_completed_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(state NOT IN ('committed','published') OR (body_prepared=1 AND admission_expires_at>0)),
  CHECK(admission_completed_at IS NULL OR state IN ('published','aborted')),
  CHECK((lease_token IS NULL)=(lease_until IS NULL))
) STRICT;
CREATE TABLE guest_core_mutation_epoch (
  id INTEGER PRIMARY KEY CHECK (id=1),
  revision INTEGER NOT NULL CHECK (revision>=0)
);
INSERT INTO guest_core_mutation_epoch VALUES(1,0);
CREATE TABLE statement_consent_guards (
  tenant_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant', 'statement')),
  scope_key TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'enforced', 'closed')),
  definition_generation INTEGER NOT NULL DEFAULT 0 CHECK (definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(definition_generation) = 'integer'),
  closed_generation INTEGER NOT NULL DEFAULT 0 CHECK (closed_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(closed_generation) = 'integer'),
  account_id TEXT NOT NULL DEFAULT '',
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(created_at) = 'integer'),
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN created_at AND 9007199254740991) CHECK (typeof(updated_at) = 'integer'),
  PRIMARY KEY (tenant_id, scope_kind, scope_key),
  CHECK ((scope_kind = 'tenant' AND scope_key = '') OR (scope_kind = 'statement' AND length(scope_key) > 0))
) WITHOUT ROWID;
CREATE TABLE statement_consent_key_states (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991) CHECK (typeof(revision) = 'integer'),
  withdrawal_generation INTEGER NOT NULL CHECK (withdrawal_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(withdrawal_generation) = 'integer'),
  last_operation_id TEXT,
  updated_at INTEGER NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(updated_at) = 'integer'),
  PRIMARY KEY (tenant_id, user_id, statement_id)
) WITHOUT ROWID;
CREATE TABLE statement_consent_operations (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64 AND operation_id NOT GLOB '*[^a-f0-9]*'),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 128),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 512),
  actor_type TEXT NOT NULL CHECK (length(actor_type) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action IN ('grant', 'deny', 'withdraw')),
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 9007199254740990) CHECK (typeof(expected_revision) = 'integer'),
  expected_withdrawal_generation INTEGER NOT NULL CHECK (expected_withdrawal_generation BETWEEN 0 AND 9007199254740990) CHECK (typeof(expected_withdrawal_generation) = 'integer'),
  expected_definition_generation INTEGER NOT NULL CHECK (expected_definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(expected_definition_generation) = 'integer'),
  expected_closed_generation INTEGER NOT NULL CHECK (expected_closed_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(expected_closed_generation) = 'integer'),
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(issued_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK (typeof(expires_at) = 'integer'),
  effect_at INTEGER NOT NULL CHECK (effect_at BETWEEN issued_at AND expires_at) CHECK (typeof(effect_at) = 'integer'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json) = 'object'),
  before_json TEXT,
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  history_json TEXT CHECK (history_json IS NULL OR (json_valid(history_json) AND json_type(history_json) = 'object')),
  admitted INTEGER NOT NULL CHECK (admitted IN (0, 1)) CHECK (typeof(admitted) = 'integer'),
  is_noop INTEGER NOT NULL CHECK (is_noop IN (0, 1)) CHECK (typeof(is_noop) = 'integer'),
  status TEXT NOT NULL DEFAULT 'executing' CHECK (status IN ('executing', 'applied', 'rejected')),
  is_terminal INTEGER NOT NULL DEFAULT 0 CHECK (is_terminal IN (0, 1)) CHECK (typeof(is_terminal) = 'integer'),
  required_terminal INTEGER NOT NULL DEFAULT 1 CHECK (required_terminal = 1) CHECK (typeof(required_terminal) = 'integer'),
  PRIMARY KEY (tenant_id, operation_id),
  UNIQUE (tenant_id, operation_id, is_terminal),
  CHECK ((status = 'executing' AND is_terminal = 0) OR (status IN ('applied', 'rejected') AND is_terminal = 1)),
  CHECK (before_json IS NULL OR (json_valid(before_json) AND json_type(before_json) = 'object')),
  CHECK ((is_noop = 1 AND history_json IS NULL AND before_json IS NOT NULL) OR (is_noop = 0 AND history_json IS NOT NULL)),
  FOREIGN KEY (tenant_id, operation_id, required_terminal)
    REFERENCES statement_consent_operations (tenant_id, operation_id, is_terminal)
    DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE TABLE statement_consent_admissions (
  tenant_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64 AND operation_id NOT GLOB '*[^a-f0-9]*'),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  statement_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991) CHECK (typeof(definition_generation) = 'integer'),
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK (typeof(issued_at) = 'integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK (typeof(expires_at) = 'integer'),
  PRIMARY KEY (tenant_id, operation_id)
) WITHOUT ROWID;
CREATE TABLE statement_consent_projection_jobs (
  tenant_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  definition_generation INTEGER NOT NULL CHECK (definition_generation BETWEEN 0 AND 9007199254740991),
  closed_generation INTEGER NOT NULL CHECK (closed_generation BETWEEN 0 AND 9007199254740991),
  mode TEXT NOT NULL CHECK (mode IN ('enforced', 'closed')),
  targets_json TEXT,
  cursor_binding_ref TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, statement_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS "user_consent_records" (
  id TEXT PRIMARY KEY
 NOT NULL
,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  granted_at INTEGER,
  withdrawn_at INTEGER,
  expires_at INTEGER,
  client_id TEXT,
  ip_address_hash TEXT,
  user_agent TEXT,
  receipt_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  retain_until INTEGER,
  consent_settings_snapshot_at INTEGER,
  record_retention_days_snapshot INTEGER,
  reconsent_interval_days_snapshot INTEGER, content_hash TEXT,
  UNIQUE (tenant_id, user_id, statement_id)
);
CREATE TABLE statement_consent_retention_permits (
  tenant_id TEXT NOT NULL,
  permit_id TEXT NOT NULL,
  row_kind TEXT NOT NULL CHECK (row_kind IN ('record','history')),
  row_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  physical_id TEXT NOT NULL,
  restore_epoch TEXT NOT NULL,
  cutoff_at INTEGER NOT NULL CHECK (cutoff_at BETWEEN 0 AND 9007199254740991) CHECK(typeof(cutoff_at)='integer'),
  legacy_retention_days INTEGER CHECK (legacy_retention_days BETWEEN 0 AND 9007199254740991 / 86400000) CHECK(legacy_retention_days IS NULL OR typeof(legacy_retention_days)='integer'),
  issued_at INTEGER NOT NULL CHECK (issued_at BETWEEN 0 AND 9007199254740991) CHECK(typeof(issued_at)='integer'),
  expires_at INTEGER NOT NULL CHECK (expires_at BETWEEN issued_at AND 9007199254740991) CHECK(typeof(expires_at)='integer'),
  PRIMARY KEY (tenant_id,permit_id)
) WITHOUT ROWID;
CREATE VIEW guest_core_erasure_started AS
SELECT g.tenant_id,g.user_id,a.id AS account_id,t.audit_id,t.operation_id,
  CASE WHEN json_valid(t.execution_progress_json) THEN t.execution_progress_json ELSE '{}' END AS progress
FROM guest_account_lifecycle g
JOIN identity_accounts a ON a.tenant_id=g.tenant_id AND a.legacy_user_id=g.user_id
JOIN guest_deletion_audit_outbox t ON t.tenant_id=g.tenant_id AND t.user_id=g.user_id
  AND t.operation_id=g.deletion_operation_id
WHERE g.phase IN ('deleting','deleted') AND t.status IN ('pending','retry')
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.schemaVersion')=2
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.tenantId')=g.tenant_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.userId')=g.user_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.operationId')=g.deletion_operation_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountId')=a.id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountRouteGeneration')=a.account_route_generation
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.completionAuditId')=t.audit_id
  AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
  AND EXISTS (SELECT 1 FROM account_legal_hold_states authority WHERE authority.tenant_id=a.tenant_id
    AND authority.account_id=a.id AND authority.projection_state='inactive' AND authority.active_hold_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h.tenant_id=a.tenant_id
    AND h.subject_type='account' AND h.subject_id=a.id AND h.state='active');
CREATE VIEW guest_core_erasure_permit_rows AS
SELECT started.tenant_id,started.user_id,started.account_id,
  json_extract(started.progress,'$.corePermit.table') AS mutation_table,key.value AS record_id
FROM guest_core_erasure_started started,
  json_each(CASE WHEN json_type(started.progress,'$.corePermit.ids')='array'
    THEN json_extract(started.progress,'$.corePermit.ids') ELSE '[]' END) key
WHERE json_extract(started.progress,'$.schemaVersion')=1
  AND json_type(started.progress,'$.revision')='integer' AND json_extract(started.progress,'$.revision')>0
  AND json_array_length(CASE WHEN json_type(started.progress,'$.corePermit.ids')='array'
    THEN json_extract(started.progress,'$.corePermit.ids') ELSE '[]' END) BETWEEN 1 AND 16
  AND key.type='text' AND length(CAST(key.value AS BLOB)) BETWEEN 1 AND 256
  AND ((json_extract(started.progress,'$.corePermit.table')='passkeys'
        AND json_extract(started.progress,'$.stage')='drain_passkeys')
    OR (json_extract(started.progress,'$.corePermit.table')='guest_devices'
        AND json_extract(started.progress,'$.stage')='drain_guest_devices')
    OR (json_extract(started.progress,'$.corePermit.table')='totp_backup_codes'
        AND json_extract(started.progress,'$.stage')='drain_totp_backup_codes')
    OR (json_extract(started.progress,'$.corePermit.table')='totp_credentials'
        AND json_extract(started.progress,'$.stage')='drain_totp_credentials')
    OR (json_extract(started.progress,'$.corePermit.table')='identity_accounts'
        AND json_extract(started.progress,'$.stage')='final_core'));
CREATE TRIGGER trg_plugin_account_metadata_mutation_immutable_update
BEFORE UPDATE ON plugin_account_metadata_mutations
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_mutation_immutable');
END;
CREATE TRIGGER trg_plugin_account_metadata_mutation_immutable_delete
BEFORE DELETE ON plugin_account_metadata_mutations
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_mutation_immutable');
END;
CREATE TRIGGER trg_plugin_account_metadata_audit_immutable_update
BEFORE UPDATE ON plugin_account_metadata_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_audit_immutable');
END;
CREATE TRIGGER trg_plugin_account_metadata_audit_immutable_delete
BEFORE DELETE ON plugin_account_metadata_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin_account_metadata_audit_immutable');
END;
CREATE TRIGGER account_webhook_guest_committed AFTER UPDATE ON guest_account_lifecycle BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.registration.changed', 'registered', 'guest', 'registration_state', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND OLD.phase = 'upgrading' AND NEW.phase = 'registered' AND a.registration_state = 'registered');
END;
CREATE TRIGGER account_webhook_user_custom_fields_insert AFTER INSERT ON user_custom_fields BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_user_custom_fields_update AFTER UPDATE ON user_custom_fields BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.legacy_user_id = NEW.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_user_custom_fields_delete AFTER DELETE ON user_custom_fields BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'custom_profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.legacy_user_id = OLD.user_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_guest_retention AFTER UPDATE ON guest_account_lifecycle BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', 'guest', 'account', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.tenant_id = NEW.tenant_id AND a.legacy_user_id = NEW.user_id AND a.account_type = 'user' AND a.registration_state = 'guest' AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleting', 'deleted') AND NEW.phase IN ('active', 'upgrading') AND (NEW.deletion_due_at IS DISTINCT FROM OLD.deletion_due_at OR NEW.upgrade_hold_until IS DISTINCT FROM OLD.upgrade_hold_until OR NEW.policy_version IS DISTINCT FROM OLD.policy_version);
END;
CREATE TRIGGER sg_user_custom_fields_insert AFTER INSERT ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_custom_fields_update AFTER UPDATE ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_custom_fields_delete AFTER DELETE ON user_custom_fields BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_insert AFTER INSERT ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_update AFTER UPDATE ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_service_group_manual_delete AFTER DELETE ON service_group_manual BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER account_webhook_created_activate AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.directory_publication_state <> 'active' AND NEW.directory_publication_state = 'active' AND OLD.directory_publication_state <> 'disabled'));
END;
CREATE TRIGGER account_webhook_created_insert AFTER INSERT ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.created', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.directory_publication_state = 'active'));
END;
CREATE TRIGGER account_webhook_deleted AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.deleted', a.registration_state, NULL, NULL, __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state = 'deleted' AND OLD.lifecycle_state <> 'deleted'));
END;
CREATE TRIGGER account_webhook_profiles_delete AFTER DELETE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND (a.primary_subject_id = OLD.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_profiles_insert AFTER INSERT ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_profiles_update AFTER UPDATE ON profiles BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND (a.primary_subject_id = NEW.subject_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_registration AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.registration.changed', a.registration_state, OLD.registration_state, 'registration_state', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (OLD.registration_state <> NEW.registration_state AND (NEW.registration_state = 'guest' OR NOT EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id = NEW.tenant_id AND g.user_id = NEW.legacy_user_id AND g.phase <> 'registered'))));
END;
CREATE TRIGGER account_webhook_updated AFTER UPDATE ON identity_accounts BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'account', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.id = NEW.id AND a.tenant_id = NEW.tenant_id AND (NEW.lifecycle_state NOT IN ('deleted', 'deleting') AND OLD.directory_publication_state = 'active' AND NEW.registration_state = OLD.registration_state AND (NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state OR NEW.display_label IS DISTINCT FROM OLD.display_label OR NEW.metadata_json IS DISTINCT FROM OLD.metadata_json)));
END;
CREATE TRIGGER sg_contact_points_delete AFTER DELETE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id), 1 WHERE (OLD.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = OLD.account_id AND tenant_id = OLD.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_contact_points_insert AFTER INSERT ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_contact_points_update AFTER UPDATE ON contact_points BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id), 1 WHERE (NEW.account_id IS NOT NULL) AND (SELECT legacy_user_id FROM identity_accounts WHERE id = NEW.account_id AND tenant_id = NEW.tenant_id) IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_delete AFTER DELETE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_insert AFTER INSERT ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_custom_claim_schemas_update AFTER UPDATE ON custom_claim_schemas BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_delete AFTER DELETE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (OLD.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_insert AFTER INSERT ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_epoch_roles_update AFTER UPDATE ON roles BEGIN
 INSERT INTO service_group_epoch(tenant_id, revision) VALUES (NEW.tenant_id, 1) ON CONFLICT(tenant_id) DO UPDATE SET revision = service_group_epoch.revision + 1;
END;
CREATE TRIGGER sg_identity_accounts_delete AFTER DELETE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.legacy_user_id, 1 WHERE (OLD.legacy_user_id IS NOT NULL) AND OLD.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_accounts_insert AFTER INSERT ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_identity_accounts_update AFTER UPDATE ON identity_accounts BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.legacy_user_id, 1 WHERE (NEW.legacy_user_id IS NOT NULL) AND NEW.legacy_user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_delete AFTER DELETE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT OLD.tenant_id, OLD.user_id, 1 WHERE (1=1) AND OLD.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_insert AFTER INSERT ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_user_roles_update AFTER UPDATE ON user_roles BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) SELECT NEW.tenant_id, NEW.user_id, 1 WHERE (1=1) AND NEW.user_id IS NOT NULL ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_write_boundary_delete AFTER DELETE ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (OLD.tenant_id, OLD.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER sg_write_boundary_insert AFTER INSERT ON service_group_write_boundaries BEGIN
 INSERT INTO service_group_inputs(tenant_id, user_id, revision) VALUES (NEW.tenant_id, NEW.user_id, 1) ON CONFLICT(tenant_id, user_id) DO UPDATE SET revision = service_group_inputs.revision + 1;
END;
CREATE TRIGGER trg_account_creation_operation_status_transition
BEFORE UPDATE OF status ON account_creation_operations
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'preparing' AND NEW.status IN ('reserved', 'blocked', 'canceled')) OR
  (OLD.status = 'reserved' AND NEW.status IN ('writing', 'blocked', 'canceled')) OR
  (OLD.status = 'writing' AND NEW.status IN ('directory_pending', 'succeeded', 'blocked')) OR
  (OLD.status = 'directory_pending' AND NEW.status IN ('succeeded', 'blocked')) OR
  (OLD.status = 'blocked' AND NEW.status IN ('reserved', 'writing', 'directory_pending', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_creation_operation_status_transition');
END;
CREATE TRIGGER trg_account_lifecycle_event_outbox_initial_state
BEFORE INSERT ON account_lifecycle_event_outbox
WHEN NEW.status <> 'pending' OR NEW.attempt_count <> 0
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_initial_state');
END;
CREATE TRIGGER trg_account_lifecycle_event_outbox_status_transition
BEFORE UPDATE OF status ON account_lifecycle_event_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_lifecycle_event_status_transition');
END;
CREATE TRIGGER trg_account_routing_outbox_status_transition
BEFORE UPDATE OF status ON account_routing_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'prepared' AND NEW.status IN ('pending', 'blocked')) OR
  (OLD.status = 'pending' AND NEW.status IN ('leased', 'succeeded', 'blocked')) OR
  (OLD.status = 'leased' AND NEW.status IN ('retry', 'succeeded', 'blocked', 'dead_letter')) OR
  (OLD.status = 'retry' AND NEW.status IN ('leased', 'succeeded', 'blocked', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_account_routing_outbox_status_transition');
END;
CREATE TRIGGER trg_account_support_context_account_immutable
BEFORE UPDATE OF tenant_id, account_id ON account_support_contexts
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.account_id <> NEW.account_id
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_immutable');
END;
CREATE TRIGGER trg_account_support_context_account_tenant_insert
BEFORE INSERT ON account_support_contexts
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.account_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_account_not_found');
END;
CREATE TRIGGER trg_account_support_context_active_hold_delete
BEFORE DELETE ON account_support_contexts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.account_id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_legal_hold_active');
END;
CREATE TRIGGER trg_account_support_context_version
BEFORE UPDATE ON account_support_contexts
WHEN NEW.version <> OLD.version + 1 OR NEW.created_by <> OLD.created_by OR
     NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'account_support_context_version_invalid');
END;
CREATE TRIGGER trg_identity_accounts_active_hold_delete
BEFORE DELETE ON identity_accounts
WHEN EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = OLD.tenant_id AND hold.subject_type = 'account'
     AND hold.subject_id = OLD.id AND hold.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'account_legal_hold_active');
END;
CREATE TRIGGER trg_identity_accounts_legal_hold_state_insert
AFTER INSERT ON identity_accounts
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.id, NULL, 'inactive', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO NOTHING;
END;
CREATE TRIGGER trg_legal_hold_events_immutable_delete
BEFORE DELETE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;
CREATE TRIGGER trg_legal_hold_events_immutable_update
BEFORE UPDATE ON legal_hold_events
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_event_immutable');
END;
CREATE TRIGGER trg_legal_holds_account_tenant_insert
BEFORE INSERT ON legal_holds
WHEN NOT EXISTS (
  SELECT 1 FROM identity_accounts account
   WHERE account.id = NEW.subject_id AND account.tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_account_not_found');
END;
CREATE TRIGGER trg_legal_holds_account_tenant_update
BEFORE UPDATE OF tenant_id, subject_type, subject_id ON legal_holds
WHEN OLD.tenant_id <> NEW.tenant_id OR OLD.subject_type <> NEW.subject_type OR
     OLD.subject_id <> NEW.subject_id
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_subject_immutable');
END;
CREATE TRIGGER trg_legal_holds_immutable_delete
BEFORE DELETE ON legal_holds
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_delete_forbidden');
END;
CREATE TRIGGER trg_legal_holds_one_active_account_insert
BEFORE INSERT ON legal_holds
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM legal_holds hold
   WHERE hold.tenant_id = NEW.tenant_id AND hold.subject_type = NEW.subject_type
     AND hold.subject_id = NEW.subject_id AND hold.state = 'active' AND hold.id <> NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_active_conflict');
END;
CREATE TRIGGER trg_legal_holds_projection_state_insert
AFTER INSERT ON legal_holds
BEGIN
  INSERT INTO account_legal_hold_states (
    tenant_id, account_id, active_hold_id, projection_state, projection_generation, updated_at
  ) VALUES (NEW.tenant_id, NEW.subject_id, NEW.id, 'active', 1, NEW.updated_at)
  ON CONFLICT (tenant_id, account_id) DO UPDATE SET
    active_hold_id = excluded.active_hold_id,
    projection_state = 'active',
    projection_generation = account_legal_hold_states.projection_generation + 1,
    updated_at = excluded.updated_at;
END;
CREATE TRIGGER trg_legal_holds_projection_state_update
AFTER UPDATE OF state ON legal_holds
WHEN OLD.state = 'active' AND NEW.state IN ('released', 'expired')
BEGIN
  UPDATE account_legal_hold_states
     SET active_hold_id = NULL, projection_state = 'inactive',
         projection_generation = projection_generation + 1, updated_at = NEW.updated_at
   WHERE tenant_id = NEW.tenant_id AND account_id = NEW.subject_id
     AND active_hold_id = NEW.id AND projection_state = 'active';
END;
CREATE TRIGGER trg_legal_holds_transition
BEFORE UPDATE ON legal_holds
WHEN NOT (
  OLD.state = 'active' AND NEW.state IN ('active', 'released', 'expired') AND
  NEW.version = OLD.version + 1 AND NEW.created_by = OLD.created_by AND
  NEW.created_at = OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'legal_hold_transition_invalid');
END;
CREATE TRIGGER trg_notification_delivery_history_recipient_immutable
BEFORE UPDATE OF account_id, recipient_masked, recipient_encrypted,
  recipient_encryption_key_version, created_at
ON notification_delivery_intents
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_history_recipient_immutable');
END;
CREATE TRIGGER trg_notification_delivery_intent_initial_state
BEFORE INSERT ON notification_delivery_intents
WHEN NEW.state <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_initial_state');
END;
CREATE TRIGGER trg_notification_delivery_intent_payload_immutable
BEFORE UPDATE OF payload_key_id, payload_envelope_json, tenant_id, plugin_installation_id,
  provider_order_version, provider_installation_ids_json, channel, notification_kind,
  payload_version, idempotency_key, request_fingerprint,
  fingerprint_key_id, expires_at, created_at
ON notification_delivery_intents
WHEN OLD.state <> 'pending'
  OR NEW.payload_key_id IS NOT NULL
  OR NEW.payload_envelope_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'notification_delivery_intent_payload_immutable');
END;
CREATE TRIGGER trg_notification_delivery_intent_state_transition
BEFORE UPDATE OF state ON notification_delivery_intents
WHEN OLD.state <> NEW.state AND NOT (
  OLD.state = 'pending' AND NEW.state IN ('delivered', 'canceled', 'expired', 'dead_letter')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_notification_delivery_intent_state_transition');
END;
CREATE TRIGGER trg_plugin_hook_outbox_claim_fencing
BEFORE UPDATE ON plugin_hook_outbox
WHEN NEW.status = 'locked' AND (
  (OLD.status IN ('queued', 'waiting_retry') AND NEW.attempt_no <> OLD.attempt_no + 1) OR
  (OLD.status = 'locked' AND (
    NOT (
      (NEW.claim_token = OLD.claim_token AND NEW.attempt_no = OLD.attempt_no) OR
      (OLD.lease_until <= NEW.updated_at AND NEW.claim_token <> OLD.claim_token
        AND NEW.attempt_no = OLD.attempt_no + 1)
    )
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_claim_fencing');
END;
CREATE TRIGGER trg_plugin_hook_outbox_initial_state
BEFORE INSERT ON plugin_hook_outbox
WHEN NEW.status <> 'queued'
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_initial_state');
END;
CREATE TRIGGER trg_plugin_hook_outbox_status_transition
BEFORE UPDATE OF status ON plugin_hook_outbox
WHEN OLD.status <> NEW.status AND NOT (
  (OLD.status = 'queued' AND NEW.status IN ('locked', 'canceled')) OR
  (OLD.status = 'locked' AND NEW.status IN ('waiting_retry', 'succeeded', 'dead_letter', 'canceled')) OR
  (OLD.status = 'waiting_retry' AND NEW.status IN ('locked', 'dead_letter', 'canceled'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plugin_hook_outbox_status_transition');
END;
CREATE TRIGGER trg_tenant_placement_capture_identity_immutable
BEFORE UPDATE OF operation_id, tenant_id, source_shard_id, migration_generation
ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_identity_immutable');
END;
CREATE TRIGGER trg_tenant_placement_capture_no_delete
BEFORE DELETE ON tenant_placement_migration_captures
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_delete_forbidden');
END;
CREATE TRIGGER trg_tenant_placement_capture_one_active_insert
BEFORE INSERT ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;
CREATE TRIGGER trg_tenant_placement_capture_one_active_update
BEFORE UPDATE OF tenant_id, capture_state ON tenant_placement_migration_captures
WHEN NEW.capture_state IN ('capturing', 'write_fenced', 'cutover_committed') AND EXISTS (
  SELECT 1
    FROM tenant_placement_migration_captures
   WHERE tenant_id = NEW.tenant_id
     AND operation_id <> OLD.operation_id
     AND capture_state IN ('capturing', 'write_fenced', 'cutover_committed')
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_active_conflict');
END;
CREATE TRIGGER trg_tenant_placement_capture_transition
BEFORE UPDATE OF capture_state ON tenant_placement_migration_captures
WHEN NOT (
  (OLD.capture_state = 'capturing' AND NEW.capture_state IN ('write_fenced', 'canceled')) OR
  (OLD.capture_state = 'write_fenced' AND NEW.capture_state IN ('capturing', 'cutover_committed', 'canceled')) OR
  OLD.capture_state = NEW.capture_state
)
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_capture_transition_invalid');
END;
CREATE TRIGGER trg_tenant_placement_outbox_payload_immutable
BEFORE UPDATE OF source_sequence, operation_id, tenant_id, table_name, mutation_kind,
                 mutation_key_json, row_json, capture_fencing_token, created_at
ON tenant_placement_migration_outbox
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_migration_outbox_payload_immutable');
END;
CREATE TRIGGER trg_tenant_placement_policy_no_scope_weakening
BEFORE UPDATE OF isolation_policy ON tenants
WHEN OLD.isolation_policy = 'tenant_exclusive'
  AND NEW.isolation_policy <> 'tenant_exclusive'
  AND NOT (
    OLD.id = 'default'
    AND OLD.created_at = OLD.updated_at
    AND (SELECT COUNT(*) FROM tenants) = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'tenant_placement_policy_scope_weakening');
END;
CREATE TRIGGER trg_tenants_lookup_retention_policy_insert
AFTER INSERT ON tenants
BEGIN
  INSERT INTO lookup_retention_policies (
    tenant_id, retention_days, policy_generation, updated_by, created_at, updated_at
  ) VALUES (NEW.id, 180, 1, 'tenant-default', NEW.created_at, NEW.updated_at)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO lookup_retention_policy_projection_outbox (
    operation_id, tenant_id, policy_generation, retention_days,
    next_attempt_at, created_at, updated_at
  )
  SELECT 'lookup-retention-policy:init:' || lower(hex(randomblob(16))),
         tenant_id, policy_generation, retention_days, updated_at, created_at, updated_at
    FROM lookup_retention_policies WHERE tenant_id = NEW.id
  ON CONFLICT (tenant_id, policy_generation) DO NOTHING;
END;
CREATE TRIGGER tenant_backup_snapshot_identity_immutable
BEFORE UPDATE OF id, tenant_id, tenant_key ON tenant_backup_snapshots
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.tenant_key IS NOT OLD.tenant_key
BEGIN SELECT RAISE(ABORT, 'snapshot_identity_immutable'); END;
CREATE TRIGGER tenant_backup_snapshot_state_monotonic
BEFORE UPDATE OF state ON tenant_backup_snapshots
WHEN (OLD.state='invalid' AND NEW.state!='invalid') OR (OLD.state='sealed' AND NEW.state='capturing')
BEGIN SELECT RAISE(ABORT,'snapshot_state_regression'); END;
CREATE TRIGGER tenant_backup_restore_target_identity
BEFORE UPDATE OF id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint ON tenant_backup_restore_targets
BEGIN SELECT RAISE(ABORT,'backup_restore_target_identity'); END;
CREATE TRIGGER tenant_backup_restore_target_monotonic
BEFORE UPDATE ON tenant_backup_restore_targets
WHEN NEW.fencing_token<OLD.fencing_token
  OR (NEW.fencing_token=OLD.fencing_token AND NEW.owner!=OLD.owner)
  OR (OLD.state='invalid' AND NEW.state!='invalid')
  OR (OLD.state='sealed' AND NEW.state='loading')
BEGIN SELECT RAISE(ABORT,'backup_restore_target_regression'); END;
CREATE TRIGGER account_webhook_profile_attribute_values_insert AFTER INSERT ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_profile_attribute_values_update AFTER UPDATE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = NEW.profile_id AND p.tenant_id = NEW.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_profile_attribute_values_delete AFTER DELETE ON profile_attribute_values BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'profile', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = (SELECT p.subject_id FROM profiles p WHERE p.id = OLD.profile_id AND p.tenant_id = OLD.tenant_id) AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_contact_points_insert AFTER INSERT ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS NOT NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_contact_points_update AFTER UPDATE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.id = NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = NEW.tenant_id AND a.primary_subject_id = NEW.subject_id AND a.id IS NOT NEW.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER account_webhook_contact_points_delete AFTER DELETE ON contact_points BEGIN
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.id = OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
INSERT INTO account_webhook_outbox (id, tenant_id, user_id, event_type, registration_state, previous_registration_state, changed_field, occurred_at) SELECT 'evt_' || lower(hex(randomblob(16))), a.tenant_id, a.legacy_user_id, 'account.updated', a.registration_state, NULL, 'contact', __AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__ FROM identity_accounts a WHERE a.account_type = 'user' AND a.legacy_user_id IS NOT NULL AND (a.tenant_id = OLD.tenant_id AND a.primary_subject_id = OLD.subject_id AND a.id IS NOT OLD.account_id AND a.directory_publication_state = 'active' AND a.lifecycle_state NOT IN ('deleted', 'deleting'));
END;
CREATE TRIGGER trg_guest_core_passkeys_insert BEFORE INSERT ON passkeys
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM passkeys existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.credential_id=NEW.credential_id)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END
;
CREATE TRIGGER trg_guest_core_passkeys_update BEFORE UPDATE ON passkeys
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='passkeys' AND permit.record_id=OLD.id))));
END;
CREATE TRIGGER trg_guest_core_passkeys_delete BEFORE DELETE ON passkeys
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='passkeys' AND permit.record_id=OLD.id)));
END;
CREATE TRIGGER trg_guest_core_totp_credentials_insert BEFORE INSERT ON totp_credentials
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM totp_credentials existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END
;
CREATE TRIGGER trg_guest_core_totp_credentials_update BEFORE UPDATE ON totp_credentials
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_credentials' AND permit.record_id=OLD.id))));
END;
CREATE TRIGGER trg_guest_core_totp_credentials_delete BEFORE DELETE ON totp_credentials
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_credentials' AND permit.record_id=OLD.id)));
END;
CREATE TRIGGER trg_guest_core_totp_backup_codes_insert BEFORE INSERT ON totp_backup_codes
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM totp_backup_codes existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.user_id=NEW.user_id AND existing.code_hash=NEW.code_hash)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END
;
CREATE TRIGGER trg_guest_core_totp_backup_codes_update BEFORE UPDATE ON totp_backup_codes
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_backup_codes' AND permit.record_id=OLD.id))));
END;
CREATE TRIGGER trg_guest_core_totp_backup_codes_delete BEFORE DELETE ON totp_backup_codes
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='totp_backup_codes' AND permit.record_id=OLD.id)));
END;
CREATE TRIGGER trg_guest_core_guest_devices_insert BEFORE INSERT ON guest_devices
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_devices existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.user_id
    WHERE (existing.id=NEW.id OR (existing.tenant_id=NEW.tenant_id AND existing.resume_credential_hash=NEW.resume_credential_hash)) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END
;
CREATE TRIGGER trg_guest_core_guest_devices_update BEFORE UPDATE ON guest_devices
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id AND g.phase IN ('deleting','deleted'))) AND NOT (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.user_id IS OLD.user_id AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='guest_devices' AND permit.record_id=OLD.id))));
END;
CREATE TRIGGER trg_guest_core_guest_devices_delete BEFORE DELETE ON guest_devices
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.user_id AND permit.mutation_table='guest_devices' AND permit.record_id=OLD.id)));
END;
CREATE TRIGGER trg_guest_core_identity_accounts_insert BEFORE INSERT ON identity_accounts
BEGIN
  -- REPLACE may perform an implicit DELETE without invoking DELETE triggers.
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM identity_accounts existing JOIN guest_account_lifecycle g
    ON g.tenant_id=existing.tenant_id AND g.user_id=existing.legacy_user_id
    WHERE (existing.id=NEW.id) AND g.phase IN ('deleting','deleted')));
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.legacy_user_id AND g.phase IN ('deleting','deleted')) AND NOT (0));
END
;
CREATE TRIGGER trg_guest_core_identity_accounts_update BEFORE UPDATE ON identity_accounts
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE ((EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.legacy_user_id AND g.phase IN ('deleting','deleted')) OR EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.legacy_user_id AND g.phase IN ('deleting','deleted'))) AND NOT (((NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.legacy_user_id IS OLD.legacy_user_id AND NEW.account_type IS OLD.account_type AND NEW.registration_state IS OLD.registration_state AND NEW.account_route_generation IS OLD.account_route_generation AND NEW.primary_subject_id IS OLD.primary_subject_id AND NEW.created_at IS OLD.created_at AND (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.legacy_user_id AND permit.mutation_table='identity_accounts' AND permit.record_id=OLD.id)) AND NEW.lifecycle_state IN ('deleting','deleted') AND (NEW.display_label IS NULL OR NEW.display_label IS OLD.display_label) AND (NEW.metadata_json IS NULL OR NEW.metadata_json IS OLD.metadata_json)) OR (NEW.id IS OLD.id AND NEW.tenant_id IS OLD.tenant_id AND NEW.legacy_user_id IS OLD.legacy_user_id AND NEW.account_type IS OLD.account_type AND NEW.registration_state IS OLD.registration_state AND NEW.account_route_generation IS OLD.account_route_generation AND NEW.primary_subject_id IS OLD.primary_subject_id AND NEW.created_at IS OLD.created_at AND NEW.display_label IS OLD.display_label AND NEW.metadata_json IS OLD.metadata_json AND NEW.lifecycle_state='deleting' AND OLD.lifecycle_state<>'deleted' AND (NEW.directory_publication_state IS OLD.directory_publication_state OR NEW.directory_publication_state='disabled') AND (OLD.deleted_at IS NULL OR NEW.deleted_at IS OLD.deleted_at) AND NEW.updated_at>=OLD.updated_at AND EXISTS (SELECT 1 FROM guest_core_erasure_started started WHERE started.tenant_id=OLD.tenant_id AND started.user_id=OLD.legacy_user_id AND started.account_id=OLD.id)))));
END;
CREATE TRIGGER trg_guest_core_identity_accounts_delete BEFORE DELETE ON identity_accounts
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_mutation_blocked') WHERE (EXISTS (SELECT 1 FROM guest_account_lifecycle g WHERE g.tenant_id=OLD.tenant_id AND g.user_id=OLD.legacy_user_id AND g.phase IN ('deleting','deleted')) AND NOT (EXISTS (SELECT 1 FROM guest_core_erasure_permit_rows permit WHERE permit.tenant_id=OLD.tenant_id AND permit.user_id=OLD.legacy_user_id AND permit.mutation_table='identity_accounts' AND permit.record_id=OLD.id)));
END;
CREATE TRIGGER trg_guest_core_hold_insert BEFORE INSERT ON legal_holds
WHEN NEW.subject_type='account' AND NEW.state='active'
BEGIN
  SELECT RAISE(ABORT,'guest_erasure_hold_admission_blocked') WHERE (EXISTS (
    SELECT 1 FROM identity_accounts a JOIN guest_account_lifecycle g
      ON g.tenant_id=a.tenant_id AND g.user_id=a.legacy_user_id
    WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.subject_id
      AND (g.phase='deleted' OR (g.phase='deleting' AND NOT (
        json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.schemaVersion') IS 2
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.operationId') IS g.deletion_operation_id
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.accountId') IS a.id
        AND json_extract(CASE WHEN json_valid(g.deletion_route_json) THEN g.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'accepted')))));
END;
CREATE TRIGGER trg_guest_core_boundary_hold_insert BEFORE INSERT ON guest_account_lifecycle
WHEN NEW.phase IN ('deleting','deleted')
  AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_legal_hold_active') WHERE (EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
    ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
    WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
      AND h.subject_type='account' AND h.state='active'));
END;
CREATE TRIGGER trg_guest_core_boundary_hold_update BEFORE UPDATE ON guest_account_lifecycle
WHEN NEW.phase IN ('deleting','deleted')
  AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase')='erasure_started'
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  SELECT RAISE(ABORT,'guest_erasure_legal_hold_active') WHERE (EXISTS (SELECT 1 FROM legal_holds h JOIN identity_accounts a
    ON a.tenant_id=h.tenant_id AND a.id=h.subject_id
    WHERE a.tenant_id=NEW.tenant_id AND a.legacy_user_id=NEW.user_id
      AND h.subject_type='account' AND h.state='active'));
END;
CREATE TRIGGER trg_guest_core_lifecycle_insert BEFORE INSERT ON guest_account_lifecycle
WHEN EXISTS (SELECT 1 FROM guest_account_lifecycle g
  WHERE g.tenant_id=NEW.tenant_id AND g.user_id=NEW.user_id
    AND g.phase IN ('deleting','deleted'))
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_delete BEFORE DELETE ON guest_account_lifecycle
WHEN OLD.phase IN ('deleting','deleted')
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_monotone BEFORE UPDATE ON guest_account_lifecycle
WHEN (OLD.phase='deleted' AND NEW.phase<>'deleted')
  OR (OLD.phase='deleting' AND NEW.phase NOT IN ('deleting','deleted'))
  OR (OLD.phase IN ('deleting','deleted') AND (
    NEW.tenant_id IS NOT OLD.tenant_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.deletion_operation_id IS NOT OLD.deletion_operation_id
    OR NEW.deletion_started_at_ms IS NOT OLD.deletion_started_at_ms))
BEGIN SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable'); END;
CREATE TRIGGER trg_guest_core_lifecycle_receipt BEFORE UPDATE OF deletion_route_json ON guest_account_lifecycle
WHEN OLD.phase IN ('deleting','deleted') AND NEW.deletion_route_json IS NOT OLD.deletion_route_json
BEGIN
  SELECT RAISE(ABORT,'guest_erasure_lifecycle_immutable') WHERE (NOT (
    OLD.phase='deleting' AND NEW.phase='deleting'
    AND json_extract(CASE WHEN json_valid(OLD.deletion_route_json) THEN OLD.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'accepted'
    AND json_extract(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution.phase') IS 'erasure_started'
    AND json_remove(CASE WHEN json_valid(OLD.deletion_route_json) THEN OLD.deletion_route_json ELSE '{}' END,'$.execution')
      IS json_remove(CASE WHEN json_valid(NEW.deletion_route_json) THEN NEW.deletion_route_json ELSE '{}' END,'$.execution')
  ));
END;
CREATE TRIGGER trg_guest_core_lifecycle_epoch AFTER UPDATE OF phase,deletion_route_json ON guest_account_lifecycle
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_owner_insert_epoch AFTER INSERT ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_owner_update_epoch AFTER UPDATE ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_owner_delete_epoch AFTER DELETE ON identity_accounts
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_insert_epoch AFTER INSERT ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_update_epoch AFTER UPDATE ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_hold_delete_epoch AFTER DELETE ON legal_holds
BEGIN UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER trg_guest_core_subject_insert_epoch AFTER INSERT ON identity_subjects
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_subject_update_epoch AFTER UPDATE ON identity_subjects
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.subject_type IS NOT OLD.subject_type OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.primary_account_id IS NOT OLD.primary_account_id OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_subject_delete_epoch AFTER DELETE ON identity_subjects
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_insert_epoch AFTER INSERT ON profiles
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_update_epoch AFTER UPDATE ON profiles
WHEN NEW.id IS NOT OLD.id OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.subject_id IS NOT OLD.subject_id OR NEW.profile_type IS NOT OLD.profile_type OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER trg_guest_core_profile_delete_epoch AFTER DELETE ON profiles
BEGIN
  SELECT RAISE(ABORT,'guest_core_admission_unavailable') WHERE (NOT EXISTS (SELECT 1 FROM guest_core_mutation_epoch WHERE id=1));
  UPDATE guest_core_mutation_epoch SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER statement_consent_operation_insert_guard BEFORE INSERT ON statement_consent_operations
WHEN NOT (NEW.is_terminal=1 AND NEW.status IN ('applied','rejected')
    AND EXISTS (SELECT 1 FROM tenant_backup_restore_targets t WHERE t.tenant_id=NEW.tenant_id
      AND t.state='loading' AND t.lease_expires_at>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      AND NEW.physical_id=t.resource_id AND NEW.restore_epoch=t.operation_id AND NEW.account_id='restore:' || t.resource_id)
    AND NOT EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id=NEW.tenant_id AND o.operation_id=NEW.operation_id)) AND (NEW.status <> 'executing' OR NEW.is_terminal <> 0 OR EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND (o.operation_id = NEW.operation_id OR (o.user_id = NEW.user_id AND o.statement_id = NEW.statement_id AND o.is_terminal = 0))) OR (NOT (json_extract(NEW.after_json, '$.tenant_id') IS NEW.tenant_id) OR NOT (json_extract(NEW.after_json, '$.user_id') IS NEW.user_id) OR NOT (json_extract(NEW.after_json, '$.statement_id') IS NEW.statement_id)
      OR (NEW.is_noop = 1 AND (NEW.action <> 'grant' OR json(NEW.after_json) <> json(NEW.before_json) OR json_extract(NEW.after_json, '$.status') <> 'granted'))
      OR (NEW.is_noop = 0 AND (json_extract(NEW.history_json, '$.id') <> ('sc_' || NEW.operation_id || ':' || NEW.tenant_id)
        OR NOT (json_extract(NEW.history_json, '$.tenant_id') IS NEW.tenant_id)
        OR NOT (json_extract(NEW.history_json, '$.user_id') IS NEW.user_id)
        OR NOT (json_extract(NEW.history_json, '$.statement_id') IS NEW.statement_id)
        OR NOT (json_extract(NEW.history_json, '$.status_before') IS json_extract(NEW.before_json, '$.status'))
        OR NOT (json_extract(NEW.history_json, '$.status_after') IS json_extract(NEW.after_json, '$.status'))
        OR NOT (json_extract(NEW.history_json, '$.version_id_after') IS json_extract(NEW.after_json, '$.version_id'))
        OR NOT (json_extract(NEW.history_json, '$.version_after') IS json_extract(NEW.after_json, '$.version'))
        OR (NEW.action = 'grant' AND (json_extract(NEW.after_json, '$.status') <> 'granted' OR json_extract(NEW.history_json, '$.action') NOT IN ('granted','version_upgraded')))
        OR (NEW.action = 'withdraw' AND (json_extract(NEW.after_json, '$.status') <> 'withdrawn' OR json_extract(NEW.history_json, '$.action') <> 'withdrawn'))
        OR (NEW.action = 'deny' AND (json_extract(NEW.after_json, '$.status') NOT IN ('denied','withdrawn') OR json_extract(NEW.history_json, '$.action') NOT IN ('denied','withdrawn')))))
      OR (NEW.before_json IS NOT NULL AND (json_extract(NEW.after_json, '$.id') <> json_extract(NEW.before_json, '$.id')
        OR json_extract(NEW.after_json, '$.created_at') <> json_extract(NEW.before_json, '$.created_at')
        OR json_extract(NEW.after_json, '$.updated_at') < json_extract(NEW.before_json, '$.updated_at'))) OR (NEW.is_noop = 0 AND NOT ((json_extract(NEW.history_json, '$.content_hash_after') IS json_extract(NEW.after_json, '$.content_hash')) AND (json_extract(NEW.history_json, '$.version_id_after') IS json_extract(NEW.after_json, '$.version_id')) AND (json_extract(NEW.history_json, '$.version_after') IS json_extract(NEW.after_json, '$.version')) AND (json_extract(NEW.history_json, '$.status_after') IS json_extract(NEW.after_json, '$.status')) AND (json_extract(NEW.history_json, '$.granted_at') IS json_extract(NEW.after_json, '$.granted_at')) AND (json_extract(NEW.history_json, '$.withdrawn_at') IS json_extract(NEW.after_json, '$.withdrawn_at')) AND (json_extract(NEW.history_json, '$.expires_at') IS json_extract(NEW.after_json, '$.expires_at')) AND (json_extract(NEW.history_json, '$.retain_until') IS json_extract(NEW.after_json, '$.retain_until')) AND (json_extract(NEW.history_json, '$.consent_settings_snapshot_at') IS json_extract(NEW.after_json, '$.consent_settings_snapshot_at')) AND (json_extract(NEW.history_json, '$.record_retention_days_snapshot') IS json_extract(NEW.after_json, '$.record_retention_days_snapshot')) AND (json_extract(NEW.history_json, '$.reconsent_interval_days_snapshot') IS json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot')))) OR CASE WHEN (json_type(NEW.after_json, '$.created_at') = 'integer' AND json_extract(NEW.after_json, '$.created_at') BETWEEN 0 AND 9007199254740991) AND (json_type(NEW.after_json, '$.updated_at') = 'integer' AND json_extract(NEW.after_json, '$.updated_at') BETWEEN 0 AND 9007199254740991) AND (json_type(NEW.after_json, '$.granted_at') = 'null' OR (json_type(NEW.after_json, '$.granted_at') = 'integer' AND json_extract(NEW.after_json, '$.granted_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.withdrawn_at') = 'null' OR (json_type(NEW.after_json, '$.withdrawn_at') = 'integer' AND json_extract(NEW.after_json, '$.withdrawn_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.expires_at') = 'null' OR (json_type(NEW.after_json, '$.expires_at') = 'integer' AND json_extract(NEW.after_json, '$.expires_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.retain_until') = 'null' OR (json_type(NEW.after_json, '$.retain_until') = 'integer' AND json_extract(NEW.after_json, '$.retain_until') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.consent_settings_snapshot_at') = 'null' OR (json_type(NEW.after_json, '$.consent_settings_snapshot_at') = 'integer' AND json_extract(NEW.after_json, '$.consent_settings_snapshot_at') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.record_retention_days_snapshot') = 'null' OR (json_type(NEW.after_json, '$.record_retention_days_snapshot') = 'integer' AND json_extract(NEW.after_json, '$.record_retention_days_snapshot') BETWEEN 0 AND 9007199254740991)) AND (json_type(NEW.after_json, '$.reconsent_interval_days_snapshot') = 'null' OR (json_type(NEW.after_json, '$.reconsent_interval_days_snapshot') = 'integer' AND json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot') BETWEEN 0 AND 9007199254740991)) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.granted_at') = 'null' OR (json_type(NEW.history_json, '$.granted_at') = 'integer' AND json_extract(NEW.history_json, '$.granted_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.withdrawn_at') = 'null' OR (json_type(NEW.history_json, '$.withdrawn_at') = 'integer' AND json_extract(NEW.history_json, '$.withdrawn_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.expires_at') = 'null' OR (json_type(NEW.history_json, '$.expires_at') = 'integer' AND json_extract(NEW.history_json, '$.expires_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.retain_until') = 'null' OR (json_type(NEW.history_json, '$.retain_until') = 'integer' AND json_extract(NEW.history_json, '$.retain_until') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.consent_settings_snapshot_at') = 'null' OR (json_type(NEW.history_json, '$.consent_settings_snapshot_at') = 'integer' AND json_extract(NEW.history_json, '$.consent_settings_snapshot_at') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.record_retention_days_snapshot') = 'null' OR (json_type(NEW.history_json, '$.record_retention_days_snapshot') = 'integer' AND json_extract(NEW.history_json, '$.record_retention_days_snapshot') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.reconsent_interval_days_snapshot') = 'null' OR (json_type(NEW.history_json, '$.reconsent_interval_days_snapshot') = 'integer' AND json_extract(NEW.history_json, '$.reconsent_interval_days_snapshot') BETWEEN 0 AND 9007199254740991))) AND (NEW.is_noop=1 OR (json_type(NEW.history_json, '$.created_at') = 'integer' AND json_extract(NEW.history_json, '$.created_at') BETWEEN 0 AND 9007199254740991)) THEN 0 ELSE 1 END = 1) OR NEW.admitted <> CASE WHEN EXISTS (SELECT 1 FROM statement_consent_guards t JOIN statement_consent_guards s ON s.tenant_id = t.tenant_id
      WHERE t.tenant_id = NEW.tenant_id AND t.scope_kind = 'tenant' AND t.scope_key = '' AND t.mode = 'enforced'
        AND s.scope_kind = 'statement' AND s.scope_key = NEW.statement_id AND (s.mode = 'enforced' OR (NEW.action <> 'grant' AND s.mode = 'closed'))
        AND t.account_id = NEW.account_id AND s.account_id = NEW.account_id
        AND t.physical_id = NEW.physical_id AND s.physical_id = NEW.physical_id
        AND t.restore_epoch = NEW.restore_epoch AND s.restore_epoch = NEW.restore_epoch
        AND s.definition_generation = NEW.expected_definition_generation
        AND s.closed_generation = NEW.expected_closed_generation)
      AND EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id
        AND k.statement_id = NEW.statement_id AND k.account_id = NEW.account_id
        AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
        AND k.revision = NEW.expected_revision AND k.withdrawal_generation = NEW.expected_withdrawal_generation)
      AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN NEW.issued_at AND NEW.expires_at
      AND ((NEW.before_json IS NULL AND NOT EXISTS (SELECT 1 FROM user_consent_records r
        WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id))
        OR EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id
          AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id
          AND json_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = json(NEW.before_json))) AND (json_extract(NEW.definition_json, '$.tenant_id')=NEW.tenant_id AND json_extract(NEW.definition_json, '$.statement_id')=NEW.statement_id AND CAST(json_extract(NEW.definition_json, '$.definition_generation') AS INTEGER)=NEW.expected_definition_generation AND json_extract(NEW.definition_json, '$.version_id')=json_extract(NEW.after_json, '$.version_id') AND json_extract(NEW.definition_json, '$.version')=json_extract(NEW.after_json, '$.version') AND (json_extract(NEW.definition_json, '$.content_hash') IS json_extract(NEW.after_json, '$.content_hash')) AND (NEW.action<>'grant' OR (CAST(json_extract(NEW.definition_json, '$.is_active') AS INTEGER)=1 AND json_extract(NEW.definition_json, '$.version_status')='active')))
      AND (NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = json_extract(NEW.history_json, '$.id'))) THEN 1 ELSE 0 END)
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_insert_guard'); END;
CREATE TRIGGER statement_consent_operation_finalize_guard BEFORE UPDATE ON statement_consent_operations
WHEN OLD.status <> 'executing' OR NOT (NEW.tenant_id IS OLD.tenant_id) OR NOT (NEW.operation_id IS OLD.operation_id) OR NOT (NEW.attempt_id IS OLD.attempt_id) OR NOT (NEW.payload_sha256 IS OLD.payload_sha256) OR NOT (NEW.actor_id IS OLD.actor_id) OR NOT (NEW.actor_type IS OLD.actor_type) OR NOT (NEW.action IS OLD.action) OR NOT (NEW.user_id IS OLD.user_id) OR NOT (NEW.account_id IS OLD.account_id) OR NOT (NEW.statement_id IS OLD.statement_id) OR NOT (NEW.physical_id IS OLD.physical_id) OR NOT (NEW.restore_epoch IS OLD.restore_epoch) OR NOT (NEW.expected_revision IS OLD.expected_revision) OR NOT (NEW.expected_withdrawal_generation IS OLD.expected_withdrawal_generation) OR NOT (NEW.expected_definition_generation IS OLD.expected_definition_generation) OR NOT (NEW.expected_closed_generation IS OLD.expected_closed_generation) OR NOT (NEW.issued_at IS OLD.issued_at) OR NOT (NEW.expires_at IS OLD.expires_at) OR NOT (NEW.effect_at IS OLD.effect_at) OR NOT (NEW.definition_json IS OLD.definition_json) OR NOT (NEW.before_json IS OLD.before_json) OR NOT (NEW.after_json IS OLD.after_json) OR NOT (NEW.history_json IS OLD.history_json) OR NOT (NEW.admitted IS OLD.admitted) OR NOT (NEW.is_noop IS OLD.is_noop) OR NOT (NEW.required_terminal IS OLD.required_terminal) OR NEW.is_terminal <> 1 OR (NEW.admitted = 0 AND NEW.status <> 'rejected') OR (NEW.admitted = 1 AND (NEW.status <> 'applied' OR NOT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN NEW.issued_at AND NEW.expires_at) OR NOT (EXISTS (SELECT 1 FROM statement_consent_key_states k WHERE k.tenant_id = NEW.tenant_id AND k.user_id = NEW.user_id AND k.statement_id = NEW.statement_id
      AND k.account_id = NEW.account_id AND k.physical_id = NEW.physical_id AND k.restore_epoch = NEW.restore_epoch
      AND k.revision = NEW.expected_revision + CASE WHEN NEW.is_noop = 1 THEN 0 ELSE 1 END
      AND k.withdrawal_generation = NEW.expected_withdrawal_generation + CASE WHEN NEW.is_noop = 0 AND NEW.action IN ('deny', 'withdraw') THEN 1 ELSE 0 END
      AND (NEW.is_noop = 1 OR k.last_operation_id = NEW.operation_id)) AND EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id
      AND r.statement_id = NEW.statement_id AND json_object('id', r.id, 'tenant_id', r.tenant_id, 'user_id', r.user_id, 'statement_id', r.statement_id, 'version_id', r.version_id, 'version', r.version, 'status', r.status, 'granted_at', r.granted_at, 'withdrawn_at', r.withdrawn_at, 'expires_at', r.expires_at, 'client_id', r.client_id, 'receipt_id', r.receipt_id, 'created_at', r.created_at, 'updated_at', r.updated_at, 'retain_until', r.retain_until, 'consent_settings_snapshot_at', r.consent_settings_snapshot_at, 'record_retention_days_snapshot', r.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', r.reconsent_interval_days_snapshot, 'content_hash', r.content_hash) = json(NEW.after_json)) AND ((NEW.is_noop = 1 AND NEW.before_json = NEW.after_json) OR
      (NEW.is_noop = 0 AND EXISTS (SELECT 1 FROM consent_item_history h WHERE h.id = json_extract(NEW.history_json, '$.id')
        AND h.tenant_id = NEW.tenant_id AND json_object('id', h.id, 'tenant_id', h.tenant_id, 'user_id', h.user_id, 'statement_id', h.statement_id, 'action', h.action, 'version_before', h.version_before, 'version_after', h.version_after, 'status_before', h.status_before, 'status_after', h.status_after, 'client_id', h.client_id, 'created_at', h.created_at, 'version_id_before', h.version_id_before, 'version_id_after', h.version_id_after, 'granted_at', h.granted_at, 'withdrawn_at', h.withdrawn_at, 'expires_at', h.expires_at, 'retain_until', h.retain_until, 'consent_settings_snapshot_at', h.consent_settings_snapshot_at, 'record_retention_days_snapshot', h.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', h.reconsent_interval_days_snapshot, 'content_hash_after', h.content_hash_after) = json(NEW.history_json)))) AND (NEW.before_json IS NULL OR NEW.is_noop = 1 OR NOT EXISTS (SELECT 1 FROM consent_item_history h
      WHERE h.tenant_id = NEW.tenant_id AND h.user_id = NEW.user_id AND h.statement_id = NEW.statement_id
        AND (h.retain_until IS NULL OR h.retain_until < json_extract(NEW.after_json, '$.retain_until')) AND (NOT (h.retain_until IS json_extract(NEW.after_json, '$.retain_until')) OR NOT (h.consent_settings_snapshot_at IS json_extract(NEW.after_json, '$.consent_settings_snapshot_at')) OR NOT (h.record_retention_days_snapshot IS json_extract(NEW.after_json, '$.record_retention_days_snapshot')) OR NOT (h.reconsent_interval_days_snapshot IS json_extract(NEW.after_json, '$.reconsent_interval_days_snapshot'))))))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_finalize_guard'); END;
CREATE TRIGGER statement_consent_operation_delete_guard BEFORE DELETE ON statement_consent_operations
WHEN OLD.is_terminal = 0
BEGIN SELECT RAISE(ABORT, 'statement_consent_operation_delete_guard'); END;
CREATE TRIGGER statement_consent_user_consent_records_insert_guard BEFORE INSERT ON user_consent_records
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = json(o.after_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_insert_guard'); END;
CREATE TRIGGER statement_consent_user_consent_records_insert_collision BEFORE INSERT ON user_consent_records
WHEN EXISTS (SELECT 1 FROM user_consent_records r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid OR (r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)) AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_insert_collision'); END;
CREATE TRIGGER statement_consent_user_consent_records_update_guard BEFORE UPDATE ON user_consent_records
WHEN ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'version_id', NEW.version_id, 'version', NEW.version, 'status', NEW.status, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'client_id', NEW.client_id, 'receipt_id', NEW.receipt_id, 'created_at', NEW.created_at, 'updated_at', NEW.updated_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash', NEW.content_hash) = json(o.after_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id AND o.status = 'executing' AND json_object('id', OLD.id, 'tenant_id', OLD.tenant_id, 'user_id', OLD.user_id, 'statement_id', OLD.statement_id, 'version_id', OLD.version_id, 'version', OLD.version, 'status', OLD.status, 'granted_at', OLD.granted_at, 'withdrawn_at', OLD.withdrawn_at, 'expires_at', OLD.expires_at, 'client_id', OLD.client_id, 'receipt_id', OLD.receipt_id, 'created_at', OLD.created_at, 'updated_at', OLD.updated_at, 'retain_until', OLD.retain_until, 'consent_settings_snapshot_at', OLD.consent_settings_snapshot_at, 'record_retention_days_snapshot', OLD.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', OLD.reconsent_interval_days_snapshot, 'content_hash', OLD.content_hash) = json(o.before_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_update_guard'); END;
CREATE TRIGGER statement_consent_user_consent_records_update_collision BEFORE UPDATE ON user_consent_records
WHEN EXISTS (SELECT 1 FROM user_consent_records r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid OR (r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)) AND r.rowid <> OLD.rowid AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_update_collision'); END;
CREATE TRIGGER statement_consent_user_consent_records_delete_guard BEFORE DELETE ON user_consent_records
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='record' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND (CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      AND OLD.status IN ('withdrawn','denied','expired')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.updated_at<p.cutoff_at-p.legacy_retention_days*86400000))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_user_consent_records_delete_guard'); END;
CREATE TRIGGER statement_consent_consent_item_history_insert_guard BEFORE INSERT ON consent_item_history
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = NEW.tenant_id AND o.user_id = NEW.user_id
              AND o.statement_id = NEW.statement_id AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
              AND json_object('id', NEW.id, 'tenant_id', NEW.tenant_id, 'user_id', NEW.user_id, 'statement_id', NEW.statement_id, 'action', NEW.action, 'version_before', NEW.version_before, 'version_after', NEW.version_after, 'status_before', NEW.status_before, 'status_after', NEW.status_after, 'client_id', NEW.client_id, 'created_at', NEW.created_at, 'version_id_before', NEW.version_id_before, 'version_id_after', NEW.version_id_after, 'granted_at', NEW.granted_at, 'withdrawn_at', NEW.withdrawn_at, 'expires_at', NEW.expires_at, 'retain_until', NEW.retain_until, 'consent_settings_snapshot_at', NEW.consent_settings_snapshot_at, 'record_retention_days_snapshot', NEW.record_retention_days_snapshot, 'reconsent_interval_days_snapshot', NEW.reconsent_interval_days_snapshot, 'content_hash_after', NEW.content_hash_after) = json(o.history_json)))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_insert_guard'); END;
CREATE TRIGGER statement_consent_consent_item_history_insert_collision BEFORE INSERT ON consent_item_history
WHEN EXISTS (SELECT 1 FROM consent_item_history r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid) AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_insert_collision'); END;
CREATE TRIGGER statement_consent_consent_item_history_update_guard BEFORE UPDATE ON consent_item_history
WHEN ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))) AND NOT (((NEW.id IS OLD.id) AND (NEW.tenant_id IS OLD.tenant_id) AND (NEW.user_id IS OLD.user_id) AND (NEW.statement_id IS OLD.statement_id) AND (NEW.action IS OLD.action) AND (NEW.version_before IS OLD.version_before) AND (NEW.version_after IS OLD.version_after) AND (NEW.status_before IS OLD.status_before) AND (NEW.status_after IS OLD.status_after) AND (NEW.client_id IS OLD.client_id) AND (NEW.created_at IS OLD.created_at) AND (NEW.version_id_before IS OLD.version_id_before) AND (NEW.version_id_after IS OLD.version_id_after) AND (NEW.granted_at IS OLD.granted_at) AND (NEW.withdrawn_at IS OLD.withdrawn_at) AND (NEW.expires_at IS OLD.expires_at) AND (NEW.ip_address_hash IS OLD.ip_address_hash) AND (NEW.user_agent IS OLD.user_agent) AND (NEW.content_hash_after IS OLD.content_hash_after) AND (NEW.metadata_json IS OLD.metadata_json)) AND EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
                  AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.before_json IS NOT NULL AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
                  AND (OLD.retain_until IS NULL OR OLD.retain_until < json_extract(o.after_json, '$.retain_until')) AND (NEW.retain_until IS json_extract(o.after_json, '$.retain_until')) AND (NEW.consent_settings_snapshot_at IS json_extract(o.after_json, '$.consent_settings_snapshot_at')) AND (NEW.record_retention_days_snapshot IS json_extract(o.after_json, '$.record_retention_days_snapshot')) AND (NEW.reconsent_interval_days_snapshot IS json_extract(o.after_json, '$.reconsent_interval_days_snapshot'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_update_guard'); END;
CREATE TRIGGER statement_consent_consent_item_history_update_collision BEFORE UPDATE ON consent_item_history
WHEN EXISTS (SELECT 1 FROM consent_item_history r WHERE (r.id = NEW.id OR r.rowid = NEW.rowid) AND r.rowid <> OLD.rowid AND ((EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = r.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) OR (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = NEW.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled'))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_update_collision'); END;
CREATE TRIGGER statement_consent_consent_item_history_delete_guard BEFORE DELETE ON consent_item_history
WHEN (EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')) AND NOT (EXISTS (SELECT 1 FROM statement_consent_retention_permits p
    JOIN statement_consent_guards g ON g.tenant_id=p.tenant_id AND g.scope_kind='tenant' AND g.scope_key=''
    WHERE p.tenant_id=OLD.tenant_id AND p.row_kind='history' AND p.row_id=OLD.id
      AND p.user_id=OLD.user_id AND p.statement_id=OLD.statement_id
      AND p.account_id=g.account_id AND p.physical_id=g.physical_id AND p.restore_epoch=g.restore_epoch
      AND (CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)) BETWEEN p.issued_at AND p.expires_at AND p.cutoff_at<=(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))
      AND NOT EXISTS (SELECT 1 FROM user_consent_records r WHERE r.tenant_id=OLD.tenant_id AND r.user_id=OLD.user_id AND r.statement_id=OLD.statement_id AND r.status='granted')
      AND ((OLD.consent_settings_snapshot_at IS NOT NULL AND OLD.retain_until IS NOT NULL AND OLD.retain_until<p.cutoff_at)
        OR (OLD.consent_settings_snapshot_at IS NULL AND p.legacy_retention_days IS NOT NULL
          AND OLD.created_at<p.cutoff_at-p.legacy_retention_days*86400000))))
BEGIN SELECT RAISE(ABORT, 'statement_consent_consent_item_history_delete_guard'); END;
CREATE TRIGGER statement_consent_key_update_guard BEFORE UPDATE ON statement_consent_key_states
WHEN NOT (NEW.tenant_id IS OLD.tenant_id) OR NOT (NEW.user_id IS OLD.user_id) OR NOT (NEW.statement_id IS OLD.statement_id) OR NOT (NEW.account_id IS OLD.account_id) OR NOT (NEW.physical_id IS OLD.physical_id) OR NOT (NEW.restore_epoch IS OLD.restore_epoch) OR NOT (EXISTS (SELECT 1 FROM statement_consent_operations o WHERE o.tenant_id = OLD.tenant_id AND o.user_id = OLD.user_id AND o.statement_id = OLD.statement_id
      AND o.status = 'executing' AND o.admitted = 1 AND o.is_noop = 0 AND o.account_id = OLD.account_id AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) BETWEEN o.issued_at AND o.expires_at
      AND OLD.revision = o.expected_revision AND OLD.withdrawal_generation = o.expected_withdrawal_generation
      AND NEW.revision = OLD.revision + 1 AND NEW.withdrawal_generation = OLD.withdrawal_generation + CASE WHEN o.action IN ('deny','withdraw') THEN 1 ELSE 0 END
      AND NEW.last_operation_id = o.operation_id AND NEW.updated_at >= OLD.updated_at))
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_update_guard'); END;
CREATE TRIGGER statement_consent_key_delete_guard BEFORE DELETE ON statement_consent_key_states
WHEN EXISTS (SELECT 1 FROM statement_consent_guards g WHERE g.tenant_id = OLD.tenant_id AND g.scope_kind = 'tenant' AND g.scope_key = '' AND g.mode <> 'disabled')
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_delete_guard'); END;
CREATE TRIGGER statement_consent_guards_replace_guard BEFORE INSERT ON statement_consent_guards
WHEN EXISTS (SELECT 1 FROM statement_consent_guards r WHERE r.tenant_id = NEW.tenant_id AND r.scope_kind = NEW.scope_kind AND r.scope_key = NEW.scope_key)
BEGIN SELECT RAISE(ABORT, 'statement_consent_guards_replace_guard'); END;
CREATE TRIGGER statement_consent_key_states_replace_guard BEFORE INSERT ON statement_consent_key_states
WHEN EXISTS (SELECT 1 FROM statement_consent_key_states r WHERE r.tenant_id = NEW.tenant_id AND r.user_id = NEW.user_id AND r.statement_id = NEW.statement_id)
BEGIN SELECT RAISE(ABORT, 'statement_consent_key_states_replace_guard'); END;
CREATE TRIGGER statement_consent_admissions_replace_guard BEFORE INSERT ON statement_consent_admissions
WHEN EXISTS (SELECT 1 FROM statement_consent_admissions r WHERE r.tenant_id = NEW.tenant_id AND r.operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'statement_consent_admissions_replace_guard'); END;
CREATE TRIGGER statement_consent_guard_monotonic BEFORE UPDATE ON statement_consent_guards
WHEN NEW.tenant_id <> OLD.tenant_id OR NEW.scope_kind <> OLD.scope_kind OR NEW.scope_key <> OLD.scope_key OR NEW.definition_generation < OLD.definition_generation OR NEW.closed_generation < OLD.closed_generation OR NEW.account_id <> OLD.account_id OR NEW.physical_id <> OLD.physical_id OR NEW.restore_epoch <> OLD.restore_epoch OR NEW.updated_at < OLD.updated_at OR (OLD.mode = 'closed' AND NEW.mode <> 'closed' AND NOT (OLD.scope_kind = 'statement' AND NEW.mode = 'enforced' AND NEW.definition_generation > OLD.definition_generation)) OR (OLD.mode = 'enforced' AND NEW.mode = 'disabled')
BEGIN SELECT RAISE(ABORT, 'statement_consent_guard_monotonic'); END;
CREATE TRIGGER statement_consent_guard_delete BEFORE DELETE ON statement_consent_guards
WHEN OLD.mode <> 'disabled'
BEGIN SELECT RAISE(ABORT, 'statement_consent_guard_delete'); END;
CREATE TRIGGER statement_consent_admission_immutable BEFORE UPDATE ON statement_consent_admissions
WHEN 1
BEGIN SELECT RAISE(ABORT, 'statement_consent_admission_immutable'); END;
CREATE TRIGGER statement_consent_retention_permit_immutable BEFORE UPDATE ON statement_consent_retention_permits
BEGIN SELECT RAISE(ABORT,'statement_consent_retention_permit_immutable'); END;
CREATE INDEX idx_oauth_clients_trust_group ON oauth_clients(tenant_id, trust_group);
CREATE INDEX idx_oauth_clients_application_type ON oauth_clients(tenant_id, application_type);
CREATE INDEX idx_user_custom_fields_search ON user_custom_fields(tenant_id, field_name, field_value);
CREATE INDEX idx_clients_claims_setting ON oauth_clients(allow_claims_without_scope);
CREATE INDEX idx_clients_created_at ON oauth_clients(created_at);
CREATE INDEX idx_clients_software_id_tenant ON oauth_clients(software_id, tenant_id);
CREATE INDEX idx_clients_trusted ON oauth_clients(is_trusted);
CREATE INDEX idx_log_chunk_record_index_time
  ON log_chunk_record_index(tenant_key, log_type, plane, event_at);
CREATE INDEX idx_log_chunk_record_index_object
  ON log_chunk_record_index(object_catalog_id);
CREATE INDEX idx_log_chunk_record_index_status
  ON log_chunk_record_index(status, created_at);
CREATE INDEX idx_flows_builtin ON flows(is_builtin);
CREATE INDEX idx_flows_client ON flows(tenant_id, client_id);
CREATE INDEX idx_flows_lookup ON flows(tenant_id, client_id, profile_id, is_active);
CREATE INDEX idx_flows_profile ON flows(tenant_id, profile_id);
CREATE INDEX idx_flows_tenant ON flows(tenant_id, is_active);
CREATE INDEX idx_oauth_clients_tenant_id ON oauth_clients(tenant_id);
CREATE INDEX idx_policy_rules_priority ON policy_rules(tenant_id, priority DESC);
CREATE INDEX idx_policy_rules_tenant ON policy_rules(tenant_id, enabled);
CREATE INDEX idx_policy_simulations_tenant ON policy_simulations(tenant_id, simulated_at DESC);
CREATE INDEX idx_scope_mappings_scope ON scope_mappings(tenant_id, scope);
CREATE INDEX idx_flows_runtime_slug
  ON flows(tenant_id, slug, deleted_at);
CREATE INDEX idx_flows_runtime_kind_status
  ON flows(tenant_id, kind, status);
CREATE INDEX idx_flows_template_id ON flows(tenant_id, template_id);
CREATE INDEX idx_oauth_clients_agent_access_lifecycle
  ON oauth_clients(tenant_id, agent_access_registration_mode, agent_access_expires_at);
CREATE UNIQUE INDEX idx_oauth_clients_agent_access_registration_slot
  ON oauth_clients(tenant_id, agent_access_registration_slot)
  WHERE agent_access_registration_mode = 'restricted_dcr'
    AND agent_access_registration_slot IS NOT NULL;
CREATE INDEX idx_plugin_account_metadata_mutations_account
  ON plugin_account_metadata_mutations(tenant_id, account_id, applied_at);
CREATE INDEX idx_plugin_account_metadata_audit_account
  ON plugin_account_metadata_audit(tenant_id, account_id, created_at);
CREATE INDEX idx_application_launchers_updated
  ON application_launchers (tenant_id, updated_at, id);
CREATE INDEX idx_launcher_favorites_user
  ON launcher_favorites (tenant_id, user_id, created_at, launcher_id);
CREATE INDEX idx_guest_lifecycle_cleanup
  ON guest_account_lifecycle (tenant_id, phase, deletion_due_at, user_id);
CREATE INDEX idx_guest_lifecycle_created
  ON guest_account_lifecycle (tenant_id, created_at, user_id);
CREATE INDEX idx_access_review_items_decision ON access_review_items(review_id, decision);
CREATE INDEX idx_access_review_items_review ON access_review_items(review_id);
CREATE INDEX idx_access_review_items_user ON access_review_items(tenant_id, user_id);
CREATE INDEX idx_access_reviews_created ON access_reviews(tenant_id, created_at);
CREATE INDEX idx_access_reviews_due ON access_reviews(tenant_id, due_date);
CREATE INDEX idx_access_reviews_reviewer ON access_reviews(tenant_id, reviewer_id);
CREATE INDEX idx_access_reviews_status ON access_reviews(tenant_id, status);
CREATE INDEX idx_account_creation_operations_status
  ON account_creation_operations(status, updated_at);
CREATE INDEX idx_account_lifecycle_event_outbox_due
  ON account_lifecycle_event_outbox(status, next_attempt_at, created_at, event_id);
CREATE INDEX idx_account_routing_outbox_account_event_route
  ON account_routing_outbox(
    tenant_id,
    account_id,
    event_kind,
    route_generation,
    status,
    outbox_id
  );
CREATE INDEX idx_account_routing_outbox_due
  ON account_routing_outbox(status, next_attempt_at, created_at);
CREATE INDEX idx_account_webhook_outbox_due ON account_webhook_outbox
  (tenant_id, delivered_at, next_attempt_at, lease_until);
CREATE INDEX idx_admin_jobs_cleanup ON admin_jobs(
  status,
  completed_at
);
CREATE INDEX idx_admin_jobs_object_catalog
  ON admin_jobs(object_catalog_id);
CREATE INDEX idx_admin_jobs_status ON admin_jobs(
  tenant_id,
  status,
  created_at DESC
);
CREATE INDEX idx_admin_jobs_tenant ON admin_jobs(
  tenant_id,
  created_at DESC
);
CREATE INDEX idx_admin_jobs_type ON admin_jobs(
  tenant_id,
  job_type,
  created_at DESC
);
CREATE INDEX idx_assurance_evidence_subject
  ON assurance_evidence(tenant_id, subject_id, evidence_type, expires_at);
CREATE INDEX idx_attribute_release_consents_destination
  ON attribute_release_consents(tenant_id, destination_type, destination_id, consent_state);
CREATE INDEX idx_attribute_verifications_result ON attribute_verifications(verification_result);
CREATE INDEX idx_attribute_verifications_runtime_validity
  ON attribute_verifications(tenant_id, verification_result, invalidated_at, revalidate_after);
CREATE INDEX idx_attribute_verifications_user ON attribute_verifications(tenant_id, user_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_cco_client ON client_consent_overrides(tenant_id, client_id);
CREATE INDEX idx_ccs_operation ON custom_claim_schemas(operation_status);
CREATE INDEX idx_ccs_tenant_active ON custom_claim_schemas(tenant_id, is_active, display_order);
CREATE INDEX idx_ccs_tenant_key ON custom_claim_schemas(tenant_id, field_key);
CREATE INDEX idx_ccsh_cleanup ON custom_claim_schema_history(tenant_id, created_at);
CREATE INDEX idx_ccsh_schema ON custom_claim_schema_history(tenant_id, schema_id, version DESC);
CREATE INDEX idx_check_api_keys_client
    ON check_api_keys(client_id);
CREATE UNIQUE INDEX idx_check_api_keys_hash
    ON check_api_keys(key_hash);
CREATE INDEX idx_check_api_keys_prefix
    ON check_api_keys(key_prefix);
CREATE INDEX idx_check_api_keys_tenant_active
    ON check_api_keys(tenant_id, is_active);
CREATE INDEX idx_ciba_client ON ciba_requests(tenant_id, client_id);
CREATE INDEX idx_ciba_status ON ciba_requests(tenant_id, status);
CREATE INDEX idx_ciba_user ON ciba_requests(tenant_id, user_id);
CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);
CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);
CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);
CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);
CREATE INDEX idx_client_trust_policies_target
  ON client_trust_policies(tenant_id, target_type, target_id);
CREATE INDEX idx_closure_ancestor_lookup
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, relation);
CREATE INDEX idx_closure_depth
  ON relationship_closure(tenant_id, depth);
CREATE INDEX idx_closure_descendant_lookup
  ON relationship_closure(tenant_id, descendant_type, descendant_id, relation);
CREATE UNIQUE INDEX idx_closure_unique
  ON relationship_closure(tenant_id, ancestor_type, ancestor_id, descendant_type, descendant_id, relation);
CREATE INDEX idx_compliance_reports_created ON compliance_reports(tenant_id, created_at);
CREATE INDEX idx_compliance_reports_requested ON compliance_reports(tenant_id, requested_by);
CREATE INDEX idx_compliance_reports_status ON compliance_reports(tenant_id, status);
CREATE INDEX idx_compliance_reports_type ON compliance_reports(tenant_id, type);
CREATE INDEX idx_consent_history_action
  ON consent_history(action, created_at);
CREATE INDEX idx_consent_history_client
  ON consent_history(client_id, created_at);
CREATE INDEX idx_consent_history_tenant
  ON consent_history(tenant_id, created_at);
CREATE INDEX idx_consent_history_user
  ON consent_history(user_id, created_at);
CREATE INDEX idx_consent_policy_items_policy
  ON consent_policy_items(tenant_id, policy_id, display_order);
CREATE INDEX idx_consent_policy_versions_effective
  ON consent_policy_versions(effective_at);
CREATE INDEX idx_consent_policy_versions_tenant
  ON consent_policy_versions(tenant_id, policy_type);
CREATE INDEX idx_consent_records_flow
  ON consent_records(tenant_id, flow_id, flow_version_id, created_at);
CREATE INDEX idx_consent_records_recipient
  ON consent_records(tenant_id, recipient_type, recipient_id, created_at);
CREATE INDEX idx_consent_records_statement
  ON consent_records(tenant_id, subject_user_id, statement_id, statement_version, status);
CREATE INDEX idx_consent_records_subject
  ON consent_records(tenant_id, subject_user_id, created_at);
CREATE INDEX idx_consent_statements_tenant ON consent_statements(tenant_id, is_active);
CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);
CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at);
CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);
CREATE INDEX idx_contact_points_lookup
  ON contact_points(tenant_id, contact_type, normalized_hash);
CREATE INDEX idx_contact_points_subject
  ON contact_points(tenant_id, subject_id, contact_type, lifecycle_state);
CREATE INDEX idx_contact_verifications_contact
  ON contact_verifications(tenant_id, contact_point_id, verification_state);
CREATE INDEX idx_credential_offers_code ON credential_offers(pre_authorized_code);
CREATE INDEX idx_credential_offers_status ON credential_offers(tenant_id, status);
CREATE INDEX idx_csl_version ON consent_statement_localizations(version_id, language);
CREATE INDEX idx_csv_effective ON consent_statement_versions(effective_at);
CREATE INDEX idx_csv_statement ON consent_statement_versions(statement_id, is_current);
CREATE UNIQUE INDEX idx_csv_unique_current
  ON consent_statement_versions(tenant_id, current_statement_guard);
CREATE INDEX idx_data_export_expires
  ON data_export_requests(expires_at);
CREATE INDEX idx_data_export_object_catalog
  ON data_export_requests(object_catalog_id);
CREATE INDEX idx_data_export_status
  ON data_export_requests(status, requested_at);
CREATE INDEX idx_data_export_user
  ON data_export_requests(user_id, status);
CREATE INDEX idx_device_codes_client_id ON device_codes(tenant_id, client_id);
CREATE INDEX idx_device_codes_expires_at ON device_codes(expires_at);
CREATE INDEX idx_device_codes_status ON device_codes(tenant_id, status);
CREATE INDEX idx_device_codes_user_code ON device_codes(user_code);
CREATE INDEX idx_device_installations_client
  ON device_installations(tenant_id, client_id, is_active);
CREATE INDEX idx_device_installations_linked_secret
  ON device_installations(tenant_id, linked_device_secret_id);
CREATE INDEX idx_device_installations_source
  ON device_installations(tenant_id, source_installation_id, client_id);
CREATE INDEX idx_device_installations_trust_group
  ON device_installations(tenant_id, trust_group_id, is_active);
CREATE INDEX idx_device_installations_user
  ON device_installations(tenant_id, user_id, is_active);
CREATE INDEX idx_device_secrets_active_expires
  ON device_secrets(is_active, expires_at);
CREATE INDEX idx_device_secrets_client
  ON device_secrets(tenant_id, client_id);
CREATE INDEX idx_device_secrets_installation
  ON device_secrets(tenant_id, installation_id);
CREATE INDEX idx_device_secrets_secret_hash
  ON device_secrets(secret_hash);
CREATE INDEX idx_device_secrets_session_id
  ON device_secrets(session_id);
CREATE INDEX idx_device_secrets_tenant_user
  ON device_secrets(tenant_id, user_id);
CREATE INDEX idx_device_secrets_trust_group
  ON device_secrets(tenant_id, trust_group_id);
CREATE INDEX idx_did_document_cache_expires ON did_document_cache(expires_at);
CREATE INDEX idx_directory_auth_config_history_tenant_time
  ON directory_auth_config_history (tenant_id, created_at);
CREATE INDEX idx_directory_auth_evidence_exports_object_catalog
  ON directory_auth_evidence_exports (object_catalog_id);
CREATE INDEX idx_directory_auth_evidence_exports_retention
  ON directory_auth_evidence_exports (tenant_id, retention_expires_at);
CREATE INDEX idx_directory_auth_evidence_exports_status
  ON directory_auth_evidence_exports (tenant_id, status, updated_at);
CREATE INDEX idx_directory_auth_migration_campaigns_status
  ON directory_auth_migration_campaigns (tenant_id, status, updated_at);
CREATE INDEX idx_directory_auth_migration_transaction_events_txn
  ON directory_auth_migration_transaction_events (tenant_id, transaction_id, created_at);
CREATE INDEX idx_directory_auth_migration_transactions_state
  ON directory_auth_migration_transactions (tenant_id, state, expires_at);
CREATE INDEX idx_directory_auth_migration_transactions_user
  ON directory_auth_migration_transactions (tenant_id, user_id, created_at);
CREATE INDEX idx_directory_auth_migration_user_states_cohort
  ON directory_auth_migration_user_states (tenant_id, campaign_id, cohort_key, updated_at);
CREATE INDEX idx_directory_auth_migration_user_states_status
  ON directory_auth_migration_user_states (tenant_id, state, updated_at);
CREATE INDEX idx_directory_auth_migration_user_states_user
  ON directory_auth_migration_user_states (tenant_id, user_id, updated_at);
CREATE INDEX idx_directory_auth_release_advisories_channel_time
  ON directory_auth_release_advisories (channel, updated_at);
CREATE INDEX idx_directory_auth_support_bundles_object_catalog
  ON directory_auth_support_bundles (object_catalog_id);
CREATE INDEX idx_directory_auth_support_bundles_retention
  ON directory_auth_support_bundles (tenant_id, retention_expires_at);
CREATE INDEX idx_directory_auth_support_bundles_status
  ON directory_auth_support_bundles (tenant_id, status, updated_at);
CREATE INDEX idx_directory_connector_instances_connector
  ON directory_connector_instances (tenant_id, connector_id, status, last_seen_at);
CREATE INDEX idx_directory_connector_status_episodes_current
  ON directory_connector_status_episodes (tenant_id, connector_id, instance_id, ended_at);
CREATE INDEX idx_directory_connector_status_episodes_recent
  ON directory_connector_status_episodes (tenant_id, connector_id, started_at);
CREATE INDEX idx_directory_identity_links_user
  ON directory_identity_links (tenant_id, user_id);
CREATE INDEX idx_directory_jit_pending_users_status
  ON directory_jit_pending_users (tenant_id, status, updated_at);
CREATE INDEX idx_entitlements_subject
  ON entitlements(tenant_id, subject_id, entitlement_type, lifecycle_state);
CREATE INDEX idx_event_log_tenant_anon_created
    ON event_log(tenant_id, anonymized_user_id, created_at);
CREATE INDEX idx_event_log_tenant_category_created
    ON event_log(tenant_id, event_category, created_at);
CREATE INDEX idx_event_log_tenant_client_created
    ON event_log(tenant_id, client_id, created_at);
CREATE INDEX idx_event_log_tenant_created
    ON event_log(tenant_id, created_at);
CREATE INDEX idx_event_log_tenant_retention
    ON event_log(tenant_id, retention_until, created_at, id);
CREATE INDEX idx_event_log_tenant_type_created
    ON event_log(tenant_id, event_type, created_at);
CREATE INDEX idx_external_idp_auth_states_consumed_at
  ON external_idp_auth_states(consumed_at);
CREATE INDEX idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);
CREATE INDEX idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);
CREATE INDEX idx_field_usage_bindings_binding
  ON field_usage_bindings(tenant_id, binding_type, binding_id, is_active);
CREATE INDEX idx_field_usage_bindings_protection
  ON field_usage_bindings(tenant_id, protection, is_active);
CREATE INDEX idx_field_usage_bindings_tenant_field
  ON field_usage_bindings(tenant_id, field_key, is_active);
CREATE INDEX idx_flow_assignments_flow
  ON flow_assignments(tenant_id, flow_id);
CREATE INDEX idx_flow_assignments_target
  ON flow_assignments(tenant_id, target_type, target_id, flow_kind);
CREATE UNIQUE INDEX idx_flow_assignments_target_unique
  ON flow_assignments(tenant_id, target_type, COALESCE(target_id, ''), flow_kind);
CREATE INDEX idx_flow_assignments_tenant_default
  ON flow_assignments(tenant_id, target_type, flow_kind, target_id);
CREATE INDEX idx_flow_audit_events_flow
  ON flow_audit_events(tenant_id, flow_id, flow_version_id, created_at);
CREATE INDEX idx_flow_audit_events_interaction
  ON flow_audit_events(tenant_id, interaction_id, created_at);
CREATE INDEX idx_flow_interaction_steps_node
  ON flow_interaction_steps(tenant_id, interaction_id, node_id);
CREATE INDEX idx_flow_interaction_steps_state
  ON flow_interaction_steps(tenant_id, interaction_id, state);
CREATE INDEX idx_flow_interactions_expiration
  ON flow_interactions(tenant_id, expires_at);
CREATE INDEX idx_flow_interactions_lookup
  ON flow_interactions(tenant_id, id);
CREATE INDEX idx_flow_interactions_state_expiration
  ON flow_interactions(tenant_id, state, expires_at);
CREATE INDEX idx_flow_interactions_state_updated
  ON flow_interactions(tenant_id, state, updated_at, id);
CREATE INDEX idx_flow_versions_lookup
  ON flow_versions(tenant_id, flow_id, version_number);
CREATE INDEX idx_flow_versions_published
  ON flow_versions(tenant_id, flow_id, published_at);
CREATE INDEX idx_group_memberships_subject
  ON group_memberships(tenant_id, subject_id, lifecycle_state);
CREATE INDEX idx_groups_tenant_state
  ON "groups"(tenant_id, lifecycle_state, display_name);
CREATE INDEX idx_guest_account_upgrades_target ON guest_account_upgrades (tenant_id, upgraded_user_id, upgraded_at);
CREATE INDEX idx_guest_account_upgrades_user ON guest_account_upgrades (tenant_id, guest_user_id, upgraded_at);
CREATE INDEX idx_guest_deletion_audit_outbox_due
  ON guest_deletion_audit_outbox (tenant_id, status, next_attempt_at, created_at);
CREATE UNIQUE INDEX idx_guest_devices_active_resume_credential ON guest_devices (tenant_id, resume_credential_hash);
CREATE INDEX idx_guest_devices_expiry ON guest_devices (tenant_id, is_active, expires_at);
CREATE INDEX idx_guest_devices_user ON guest_devices (tenant_id, user_id, is_active, last_used_at DESC);
CREATE INDEX idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);
CREATE INDEX idx_idempotency_keys_lookup
    ON idempotency_keys(tenant_id, actor_id, idempotency_key);
CREATE INDEX idx_identity_accounts_directory_publication
  ON identity_accounts(tenant_id, directory_publication_state, created_at, id);
CREATE INDEX idx_identity_accounts_legacy_user
  ON identity_accounts(tenant_id, legacy_user_id);
CREATE INDEX idx_identity_accounts_registration_state ON identity_accounts (tenant_id, registration_state);
CREATE INDEX idx_identity_accounts_tenant_state
  ON identity_accounts(tenant_id, account_type, lifecycle_state);
CREATE INDEX idx_identity_bindings_subject
  ON identity_bindings(tenant_id, subject_id, lifecycle_state);
CREATE UNIQUE INDEX idx_identity_providers_saml_entity_id
  ON identity_providers(
    tenant_id,
    provider_type,
    json_extract(config_json, '$.entityId')
  )
  WHERE provider_type IN ('saml_idp', 'saml_sp')
    AND json_valid(config_json)
    AND json_type(config_json, '$.entityId') = 'text';
CREATE INDEX idx_identity_providers_type ON identity_providers(provider_type);
CREATE INDEX idx_identity_resolution_candidates_state
  ON identity_resolution_candidates(tenant_id, decision_state, created_at);
CREATE INDEX idx_identity_resolution_events_subject
  ON identity_resolution_events(tenant_id, subject_id, created_at);
CREATE INDEX idx_identity_subjects_tenant_type
  ON identity_subjects(tenant_id, subject_type, lifecycle_state);
CREATE INDEX idx_internal_notification_delivery_attempts_event
  ON internal_notification_delivery_attempts(event_id, provider, status);
CREATE INDEX idx_internal_notification_delivery_attempts_retry
  ON internal_notification_delivery_attempts(status, next_attempt_at, updated_at);
CREATE INDEX idx_internal_notification_delivery_routes_lookup
  ON internal_notification_delivery_routes(scope_type, scope_id, enabled, provider);
CREATE UNIQUE INDEX idx_internal_notification_events_dedup
  ON internal_notification_events(deduplication_key);
CREATE INDEX idx_internal_notification_events_pending
  ON internal_notification_events(status, severity, created_at);
CREATE INDEX idx_internal_notification_events_tenant_created
  ON internal_notification_events(tenant_id, created_at DESC);
CREATE INDEX idx_issued_credentials_status ON issued_credentials(tenant_id, status);
CREATE INDEX idx_issued_credentials_status_list
    ON issued_credentials(tenant_id, status_list_internal_id, status_list_index);
CREATE INDEX idx_issued_credentials_type ON issued_credentials(tenant_id, credential_type);
CREATE INDEX idx_issued_credentials_user ON issued_credentials(tenant_id, user_id);
CREATE INDEX idx_legal_hold_events_account
  ON legal_hold_events(tenant_id, account_id, created_at DESC, event_id DESC);
CREATE INDEX idx_legal_hold_projection_outbox_runnable
  ON legal_hold_projection_outbox(status, next_attempt_at, tenant_id, operation_id);
CREATE INDEX idx_legal_holds_account_history
  ON legal_holds(tenant_id, subject_id, created_at DESC, id DESC);
CREATE INDEX idx_legal_holds_expiry
  ON legal_holds(state, expires_at, tenant_id, id);
CREATE UNIQUE INDEX idx_log_chunk_manifests_bucket
  ON log_chunk_manifests(tenant_key, log_type, plane, bucket_start_at, shard);
CREATE UNIQUE INDEX idx_log_object_catalog_object_key
  ON log_object_catalog(object_key);
CREATE INDEX idx_log_object_catalog_status
  ON log_object_catalog(status, created_at);
CREATE INDEX idx_log_object_catalog_tenant_type_time
  ON log_object_catalog(tenant_key, log_type, plane, created_at);
CREATE INDEX idx_logging_catalog_repair_jobs_queue
  ON logging_catalog_repair_jobs(status, created_at);
CREATE INDEX idx_logging_quota_evaluations_state
  ON logging_quota_evaluations(state, evaluated_at DESC);
CREATE INDEX idx_logging_quota_policies_lookup
  ON logging_quota_policies(scope_type, scope_id, status, metric_name, window_kind);
CREATE INDEX idx_logging_usage_aggregates_window
  ON logging_usage_aggregates(window_kind, window_start_at, metric_name);
CREATE INDEX idx_lookup_retention_policy_projection_outbox_runnable
  ON lookup_retention_policy_projection_outbox(
    status, next_attempt_at, tenant_id, policy_generation
  );
CREATE INDEX idx_notification_delivery_history_account_created
  ON notification_delivery_intents(tenant_id, account_id, created_at DESC, intent_id DESC);
CREATE INDEX idx_notification_delivery_history_tenant_created
  ON notification_delivery_intents(tenant_id, created_at DESC, intent_id DESC);
CREATE INDEX idx_notification_delivery_intents_pending
  ON notification_delivery_intents(tenant_id, state, expires_at, intent_id);
CREATE INDEX idx_notification_delivery_intents_retention
  ON notification_delivery_intents(delete_after, state, intent_id);
CREATE INDEX idx_object_catalog_deleted_at
  ON object_catalog(deleted_at);
CREATE INDEX idx_object_catalog_tenant_class_created
  ON object_catalog(tenant_id, object_class, created_at DESC);
CREATE INDEX idx_odm_lookup ON org_domain_mappings(
  tenant_id,
  domain_hash,
  is_active,
  verified DESC,
  priority DESC
);
CREATE INDEX idx_odm_org ON org_domain_mappings(org_id);
CREATE INDEX idx_odm_verification_status ON org_domain_mappings(
  verification_status,
  verification_expires_at
);
CREATE INDEX idx_odm_version ON org_domain_mappings(domain_hash_version);
CREATE INDEX idx_oidc_scopes_enabled
  ON oidc_scopes(tenant_id, enabled, name);
CREATE INDEX idx_operational_logs_actor
    ON operational_logs(actor_id);
CREATE INDEX idx_operational_logs_detail_object_catalog
    ON operational_logs(detail_object_catalog_id);
CREATE INDEX idx_operational_logs_expires
    ON operational_logs(expires_at);
CREATE INDEX idx_operational_logs_subject
    ON operational_logs(subject_type, subject_id);
CREATE INDEX idx_operational_logs_tenant_created
    ON operational_logs(tenant_id, created_at DESC);
CREATE INDEX idx_organizations_is_active ON organizations(is_active);
CREATE INDEX idx_organizations_org_type ON organizations(org_type);
CREATE INDEX idx_organizations_parent_org_id ON organizations(parent_org_id);
CREATE UNIQUE INDEX idx_organizations_tenant_name ON organizations(tenant_id, name);
CREATE INDEX idx_passkeys_credential ON passkeys(tenant_id, credential_id);
CREATE INDEX idx_passkeys_routing_authority
  ON passkeys(tenant_id, created_at, id);
CREATE INDEX idx_passkeys_user ON passkeys(tenant_id, user_id);
CREATE INDEX idx_password_reset_user ON password_reset_tokens(tenant_id, user_id);
CREATE INDEX idx_pca_api_key
    ON permission_check_audit(api_key_id);
CREATE INDEX idx_pca_checked_at
    ON permission_check_audit(checked_at);
CREATE INDEX idx_pca_denied
    ON permission_check_audit(tenant_id, final_decision);
CREATE INDEX idx_pca_tenant_subject
    ON permission_check_audit(tenant_id, subject_id);
CREATE INDEX idx_pcaudit_event_type
    ON permission_change_audit(tenant_id, event_type);
CREATE INDEX idx_pcaudit_tenant_subject
    ON permission_change_audit(tenant_id, subject_id);
CREATE INDEX idx_pcaudit_timestamp
    ON permission_change_audit(timestamp);
CREATE INDEX idx_plugin_account_metadata_installation
  ON plugin_account_metadata(tenant_id, plugin_installation_id, account_id);
CREATE INDEX idx_plugin_hook_outbox_due
  ON plugin_hook_outbox(status, next_attempt_at, created_at);
CREATE INDEX idx_plugin_hook_outbox_retention
  ON plugin_hook_outbox(delete_after, status);
CREATE INDEX idx_profile_attribute_values_profile
  ON profile_attribute_values(tenant_id, profile_id, catalog_entry_id, lifecycle_state);
CREATE INDEX idx_rar_evaluation ON role_assignment_rules(
  tenant_id,
  is_active,
  priority DESC
);
CREATE INDEX idx_rar_role ON role_assignment_rules(role_id);
CREATE INDEX idx_relation_defs_active
  ON relation_definitions(tenant_id, is_active);
CREATE INDEX idx_relation_defs_lookup
  ON relation_definitions(tenant_id, object_type, relation_name);
CREATE INDEX idx_relation_defs_tenant_object
  ON relation_definitions(tenant_id, object_type);
CREATE UNIQUE INDEX idx_relation_defs_unique
  ON relation_definitions(tenant_id, object_type, relation_name);
CREATE INDEX idx_relationships_evidence_type
  ON relationships(tenant_id, evidence_type);
CREATE INDEX idx_relationships_expires_at ON relationships(expires_at);
CREATE INDEX idx_relationships_from ON relationships(tenant_id, from_type, from_id);
CREATE INDEX idx_relationships_to ON relationships(tenant_id, to_type, to_id);
CREATE INDEX idx_relationships_type ON relationships(tenant_id, relationship_type);
CREATE UNIQUE INDEX idx_relationships_unique
  ON relationships(tenant_id, relationship_type, from_type, from_id, to_type, to_id);
CREATE INDEX idx_roles_hierarchy_level ON roles(hierarchy_level);
CREATE INDEX idx_roles_name ON roles(tenant_id, name);
CREATE INDEX idx_roles_parent_role_id ON roles(tenant_id, parent_role_id);
CREATE INDEX idx_roles_role_type ON roles(role_type);
CREATE INDEX idx_rp_expires ON resource_permissions(expires_at);
CREATE INDEX idx_rp_lookup ON resource_permissions(
  tenant_id,
  subject_type,
  subject_id,
  resource_type,
  is_active
);
CREATE INDEX idx_rp_resource ON resource_permissions(
  tenant_id,
  resource_type,
  resource_id,
  is_active
);
CREATE INDEX idx_rtsc_activated_at
  ON refresh_token_shard_configs(activated_at);
CREATE INDEX idx_rtsc_generation
  ON refresh_token_shard_configs(generation);
CREATE INDEX idx_rtsc_tenant_client
  ON refresh_token_shard_configs(tenant_id, client_id);
CREATE INDEX idx_saml_attribute_presets_applies_to ON saml_attribute_presets(tenant_id, applies_to);
CREATE INDEX idx_saml_attribute_presets_tenant ON saml_attribute_presets(tenant_id, created_at DESC);
CREATE INDEX idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);
CREATE INDEX idx_security_alerts_tenant_created
    ON security_alerts(tenant_id, created_at DESC);
CREATE INDEX idx_security_alerts_tenant_severity
    ON security_alerts(tenant_id, severity);
CREATE INDEX idx_security_alerts_tenant_status
    ON security_alerts(tenant_id, status);
CREATE INDEX idx_security_alerts_tenant_type
    ON security_alerts(tenant_id, type);
CREATE INDEX idx_security_alerts_user
    ON security_alerts(user_id);
CREATE INDEX idx_security_threats_detected ON security_threats(tenant_id, detected_at);
CREATE INDEX idx_security_threats_severity ON security_threats(tenant_id, severity);
CREATE INDEX idx_security_threats_status ON security_threats(tenant_id, status);
CREATE INDEX idx_security_threats_type ON security_threats(tenant_id, type);
CREATE INDEX idx_service_group_audit_subject ON service_group_audit(tenant_id, user_id, created_at);
CREATE INDEX idx_service_group_write_boundaries_subject ON service_group_write_boundaries(tenant_id, user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_external_provider_sid
  ON sessions(tenant_id, external_provider_id, external_provider_sid)
  WHERE external_provider_sid IS NOT NULL;
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);
CREATE INDEX idx_sessions_user ON sessions(tenant_id, user_id);
CREATE INDEX idx_settings_history_actor ON settings_history(
  actor_id,
  created_at DESC
);
CREATE INDEX idx_settings_history_category ON settings_history(
  tenant_id,
  category,
  version DESC
);
CREATE INDEX idx_settings_history_cleanup ON settings_history(
  tenant_id,
  category,
  created_at
);
CREATE INDEX idx_soa_approval_request
  ON support_operation_actions(tenant_id, approval_request_id);
CREATE INDEX idx_soa_cohort
  ON support_operation_actions(tenant_id, cohort_id);
CREATE INDEX idx_soa_tenant_created
  ON support_operation_actions(tenant_id, created_at DESC);
CREATE INDEX idx_soa_tenant_status
  ON support_operation_actions(tenant_id, status, updated_at DESC);
CREATE INDEX idx_soc_selector_hash
  ON support_operation_cohorts(tenant_id, resource, selector_hash);
CREATE INDEX idx_soc_snapshot_status
  ON support_operation_cohorts(tenant_id, snapshot_status, created_at DESC);
CREATE INDEX idx_soc_tenant_created
  ON support_operation_cohorts(tenant_id, created_at DESC);
CREATE INDEX idx_soc_tenant_expires
  ON support_operation_cohorts(tenant_id, expires_at);
CREATE INDEX idx_soct_cohort
  ON support_operation_cohort_targets(tenant_id, cohort_id);
CREATE INDEX idx_soct_cohort_block
  ON support_operation_cohort_targets(tenant_id, cohort_id, block_reason);
CREATE INDEX idx_status_lists_tenant_public ON status_lists(tenant_id, public_id);
CREATE INDEX idx_structured_attribute_values_owner
  ON structured_attribute_values(tenant_id, owner_type, owner_id, catalog_entry_id);
CREATE INDEX idx_subject_account_links_account
  ON subject_account_links(tenant_id, account_id, lifecycle_state);
CREATE INDEX idx_subject_lifecycle_timeline_subject
  ON subject_lifecycle_timeline_events(tenant_id, subject_id, event_at);
CREATE INDEX idx_suspicious_activities_created ON suspicious_activities(tenant_id, created_at);
CREATE INDEX idx_suspicious_activities_severity ON suspicious_activities(tenant_id, severity);
CREATE INDEX idx_suspicious_activities_type ON suspicious_activities(tenant_id, type);
CREATE INDEX idx_suspicious_activities_user ON suspicious_activities(tenant_id, user_id);
CREATE INDEX idx_tcr_evaluation ON token_claim_rules(
  tenant_id,
  token_type,
  is_active,
  priority DESC,
  created_at ASC
);
CREATE UNIQUE INDEX idx_tdm_domain_hash ON tenant_domain_mappings(active_domain_hash);
CREATE INDEX idx_tdm_domain_lookup ON tenant_domain_mappings(domain_hash, is_active);
CREATE INDEX idx_tdm_verified ON tenant_domain_mappings(verified, is_active, priority DESC);
CREATE INDEX idx_tenant_database_probe_results_scope
  ON tenant_database_probe_results(tenant_id, role, shard_group, created_at DESC);
CREATE INDEX idx_tenant_placement_capture_tenant_state
  ON tenant_placement_migration_captures(tenant_id, capture_state);
CREATE INDEX idx_tenant_placement_outbox_pending
  ON tenant_placement_migration_outbox(operation_id, delivery_state, source_sequence);
CREATE UNIQUE INDEX idx_tenants_is_default ON tenants(default_tenant_guard);
CREATE INDEX idx_ti_tenant ON tenant_invitations(tenant_id, created_at DESC);
CREATE INDEX idx_ti_token ON tenant_invitations(token, expires_at);
CREATE INDEX idx_token_families_client ON user_token_families(tenant_id, client_id);
CREATE INDEX idx_token_families_user ON user_token_families(tenant_id, user_id);
CREATE INDEX idx_totp_backup_codes_unused
  ON totp_backup_codes(tenant_id, user_id, used_at);
CREATE INDEX idx_totp_backup_codes_user
  ON totp_backup_codes(tenant_id, user_id);
CREATE INDEX idx_totp_credentials_active_user
  ON totp_credentials(tenant_id, user_id, status);
CREATE INDEX idx_totp_credentials_tenant_user
  ON totp_credentials(tenant_id, user_id);
CREATE INDEX idx_trusted_issuers_did ON trusted_issuers(issuer_did);
CREATE UNIQUE INDEX idx_tvd_hostname_active ON tenant_vanity_domains(active_hostname);
CREATE INDEX idx_tvd_hostname_lookup ON tenant_vanity_domains(hostname, is_active);
CREATE UNIQUE INDEX idx_tvd_primary_active ON tenant_vanity_domains(primary_active_tenant_key);
CREATE INDEX idx_tvd_primary_lookup ON tenant_vanity_domains(tenant_id, is_primary, is_active, status);
CREATE INDEX idx_tvd_status ON tenant_vanity_domains(status, is_active);
CREATE INDEX idx_upstream_providers_enable_sso
  ON upstream_providers(tenant_id, enable_sso);
CREATE INDEX idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);
CREATE UNIQUE INDEX idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);
CREATE UNIQUE INDEX idx_upstream_providers_tenant_slug
  ON upstream_providers(tenant_id, slug);
CREATE INDEX idx_user_roles_role ON user_roles(tenant_id, role_id, created_at);
CREATE INDEX idx_user_verified_attributes_name ON user_verified_attributes(tenant_id, attribute_name);
CREATE INDEX idx_user_verified_attributes_user ON user_verified_attributes(tenant_id, user_id);
CREATE INDEX idx_users_core_email_domain ON users_core(email_domain_hash);
CREATE INDEX idx_users_core_partition ON users_core(pii_partition);
CREATE INDEX idx_users_core_pii_status ON users_core(pii_status);
CREATE INDEX idx_users_core_status ON users_core(tenant_id, status);
CREATE INDEX idx_users_core_tenant_external_id ON users_core(tenant_id, external_id);
CREATE INDEX idx_users_core_type ON users_core(tenant_id, user_type);
CREATE INDEX idx_users_created_at ON users(created_at);
CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX idx_users_tenant_status ON users(tenant_id, status);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_value_provenance_owner
  ON value_provenance(tenant_id, owner_table, owner_id, observed_at);
CREATE INDEX idx_vp_requests_nonce ON vp_requests(nonce);
CREATE INDEX idx_vp_requests_tenant_status ON vp_requests(tenant_id, status);
CREATE INDEX idx_web_origin_registry_client
  ON web_origin_registry(tenant_id, client_id, is_active);
CREATE INDEX idx_web_origin_registry_origin
  ON web_origin_registry(tenant_id, origin, is_active);
CREATE INDEX idx_webhook_configs_active ON webhook_configs(tenant_id, active);
CREATE INDEX idx_webhook_configs_client ON webhook_configs(tenant_id, client_id);
CREATE INDEX idx_webhook_configs_scope ON webhook_configs(tenant_id, scope);
CREATE INDEX idx_webhook_deliveries_detail_object_catalog
  ON webhook_deliveries(detail_object_catalog_id);
CREATE INDEX idx_webhook_deliveries_status_created
  ON webhook_deliveries(status, created_at DESC);
CREATE INDEX idx_webhook_deliveries_tenant_created
  ON webhook_deliveries(tenant_id, created_at DESC);
CREATE INDEX idx_webhook_deliveries_webhook_created
  ON webhook_deliveries(webhook_id, created_at DESC);
CREATE INDEX idx_webhook_delivery_logs_created ON webhook_delivery_logs(created_at);
CREATE INDEX idx_webhook_delivery_logs_event ON webhook_delivery_logs(event_id);
CREATE INDEX idx_webhook_delivery_logs_webhook ON webhook_delivery_logs(webhook_id);
CREATE UNIQUE INDEX uniq_ccs_active_key
  ON custom_claim_schemas(tenant_id, active_field_key);
CREATE INDEX tenant_backup_snapshots_capture
  ON tenant_backup_snapshots(state, tenant_id, id);
CREATE UNIQUE INDEX tenant_backup_restore_target_exclusive ON tenant_backup_restore_targets((1));
CREATE UNIQUE INDEX idx_access_review_items_entitlement
  ON access_review_items(review_id, permission_type, entitlement_ref);
CREATE INDEX idx_compliance_reports_expiry
  ON compliance_reports(tenant_id, status, expires_at);
CREATE INDEX tenant_backup_preimages_native_order
  ON tenant_backup_preimages(snapshot_id, source_table, present,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[0][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[0][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[0][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[0][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[0][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[1][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[1][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[1][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[1][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[1][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[2][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[2][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[2][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[2][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[2][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[3][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[3][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[3][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[3][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[3][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[4][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[4][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[4][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[4][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[4][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[5][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[5][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[5][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[5][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[5][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[6][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[6][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[6][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[6][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[6][1]')) END,
    CASE CASE WHEN json_valid(record_key) THEN json_extract(record_key, '$[7][0]') END WHEN 'integer' THEN CAST(json_extract(record_key, '$[7][1]') AS INTEGER) WHEN 'real' THEN CAST(json_extract(record_key, '$[7][1]') AS REAL) WHEN 'text' THEN json_extract(record_key, '$[7][1]') WHEN 'blob' THEN unhex(json_extract(record_key, '$[7][1]')) END);
CREATE INDEX idx_access_reviews_tenant ON access_reviews(tenant_id, id);
CREATE INDEX idx_audit_log_tenant_id ON audit_log(tenant_id, id);
CREATE INDEX idx_compliance_reports_tenant ON compliance_reports(tenant_id, id);
CREATE INDEX idx_credential_configurations_tenant ON credential_configurations(tenant_id, id);
CREATE INDEX idx_organizations_tenant_id ON organizations(tenant_id, id);
CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id, id);
CREATE INDEX idx_presentation_definitions_tenant ON presentation_definitions(tenant_id, id);
CREATE INDEX idx_relationships_tenant_id ON relationships(tenant_id, id);
CREATE INDEX idx_roles_tenant_id ON roles(tenant_id, id);
CREATE INDEX idx_security_threats_tenant ON security_threats(tenant_id, id);
CREATE INDEX idx_status_lists_tenant ON status_lists(tenant_id, internal_id);
CREATE INDEX idx_suspicious_activities_tenant ON suspicious_activities(tenant_id, id);
CREATE INDEX idx_tcr_tenant ON tenant_consent_requirements(tenant_id, id);
CREATE INDEX idx_tdm_tenant ON tenant_domain_mappings(tenant_id, id);
CREATE INDEX idx_tvd_tenant ON tenant_vanity_domains(tenant_id, id);
CREATE INDEX idx_trusted_issuers_tenant ON trusted_issuers(tenant_id, id);
CREATE INDEX idx_upstream_providers_tenant_id ON upstream_providers(tenant_id, id);
CREATE INDEX idx_users_tenant_id ON users(tenant_id, id);
CREATE INDEX idx_users_core_tenant ON users_core(tenant_id, id);
CREATE INDEX idx_webhook_configs_tenant ON webhook_configs(tenant_id, id);
CREATE INDEX idx_webhook_delivery_logs_tenant ON webhook_delivery_logs(tenant_id, id);
CREATE INDEX idx_identity_accounts_primary_subject
  ON identity_accounts(tenant_id, primary_subject_id);
CREATE INDEX idx_flow_audit_events_tenant_created
  ON flow_audit_events(tenant_id, created_at, id);
CREATE INDEX idx_provisioning_assignment_events_tenant_created
  ON provisioning_assignment_events(tenant_id, created_at, id);
CREATE INDEX idx_provisioning_revocation_events_tenant_created
  ON provisioning_revocation_events(tenant_id, created_at, id);
CREATE INDEX idx_service_group_audit_tenant_created
  ON service_group_audit(tenant_id, created_at, id);
CREATE INDEX idx_directory_auth_migration_tx_events_tenant_created
  ON directory_auth_migration_transaction_events(tenant_id, created_at, id);
CREATE INDEX idx_audit_log_tenant_created
  ON audit_log(tenant_id, created_at, id);
CREATE INDEX idx_permission_change_audit_tenant_timestamp
  ON permission_change_audit(tenant_id, timestamp, id);
CREATE INDEX idx_permission_check_audit_tenant_checked
  ON permission_check_audit(tenant_id, checked_at, id);
CREATE UNIQUE INDEX idx_tenant_invitation_redemptions_holder
  ON tenant_invitation_redemptions(tenant_id, invitation_id, holder);
CREATE INDEX idx_tenant_invitation_redemptions_tenant
  ON tenant_invitation_redemptions(tenant_id, id);
CREATE INDEX idx_tenant_invitation_redemptions_expiry
  ON tenant_invitation_redemptions(tenant_id, invitation_id, status, expires_at);
CREATE INDEX idx_role_assignments_role ON role_assignments(tenant_id, role_id);
CREATE INDEX idx_role_assignments_subject ON role_assignments(tenant_id, subject_id);
CREATE INDEX idx_membership_org ON subject_org_membership(tenant_id, org_id);
CREATE INDEX idx_membership_subject ON subject_org_membership(tenant_id, subject_id);
CREATE INDEX idx_flow_audit_events_subject
  ON flow_audit_events(tenant_id, subject_hash, created_at)
  WHERE subject_hash IS NOT NULL;
CREATE UNIQUE INDEX idx_flow_audit_events_inquiry
  ON flow_audit_events(tenant_id, inquiry_number)
  WHERE inquiry_number IS NOT NULL;
CREATE INDEX idx_support_ops_account_result_receipts_cleanup
  ON support_ops_account_result_receipts (delete_after_ms, receipt_id)
  WHERE acknowledged_at_ms IS NOT NULL;
CREATE INDEX idx_support_ops_account_result_receipts_unacknowledged
  ON support_ops_account_result_receipts (tenant_id, created_at_ms, receipt_id)
  WHERE acknowledged_at_ms IS NULL;
CREATE INDEX idx_provisioning_revocation_receipts_account
  ON provisioning_revocation_receipts(tenant_id,account_id,source_event_id,id);
CREATE INDEX idx_log_iceberg_core_publications_pending
  ON log_iceberg_core_publications(tenant_id,state,updated_at,id);
CREATE INDEX idx_guest_erasure_passkeys_page ON passkeys(tenant_id,user_id,id);
CREATE INDEX idx_guest_erasure_guest_devices_page ON guest_devices(tenant_id,user_id,id);
CREATE INDEX idx_guest_erasure_totp_credentials_page ON totp_credentials(tenant_id,user_id,id);
CREATE INDEX idx_guest_erasure_totp_backup_codes_page ON totp_backup_codes(tenant_id,user_id,id);
CREATE INDEX idx_guest_erasure_directory_page ON account_routing_outbox(tenant_id,account_id,event_kind,outbox_id);
CREATE UNIQUE INDEX idx_statement_consent_one_executing_key ON statement_consent_operations
  (tenant_id, user_id, statement_id) WHERE is_terminal = 0;
CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);
CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);
CREATE INDEX idx_ucr_status ON user_consent_records(status);
CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);

PRAGMA foreign_keys = ON;
