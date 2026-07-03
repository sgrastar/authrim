-- Consent records, Form profiles, and OIDC Scope master.
-- Adds the admin/runtime resources needed by Flow Consent/Form nodes.

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_consent_records_subject
  ON consent_records(tenant_id, subject_user_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consent_records_statement
  ON consent_records(tenant_id, subject_user_id, statement_id, statement_version, status);

CREATE INDEX IF NOT EXISTS idx_consent_records_recipient
  ON consent_records(tenant_id, recipient_type, recipient_id, created_at);

CREATE INDEX IF NOT EXISTS idx_consent_records_flow
  ON consent_records(tenant_id, flow_id, flow_version_id, created_at);

CREATE TABLE IF NOT EXISTS form_profiles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  profile_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  form_kind TEXT NOT NULL CHECK (
    form_kind IN ('registration', 'profile_completion', 'login', 'custom')
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, profile_key)
);

CREATE INDEX IF NOT EXISTS idx_form_profiles_kind
  ON form_profiles(tenant_id, form_kind, is_active);

CREATE TABLE IF NOT EXISTS oidc_scopes (
  id TEXT PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_oidc_scopes_enabled
  ON oidc_scopes(tenant_id, enabled, name);

INSERT INTO oidc_scopes
  (id, tenant_id, name, display_name, description, scope_type, enabled, localizations_json, created_at, updated_at)
VALUES
  ('scope-openid-default', 'default', 'openid', 'OpenID', 'Sign in with an OpenID Connect identity.', 'system', 1, NULL, 0, 0),
  ('scope-profile-default', 'default', 'profile', 'Profile', 'Access basic profile claims such as name and preferred username.', 'system', 1, NULL, 0, 0),
  ('scope-email-default', 'default', 'email', 'Email', 'Access email address and email verification status.', 'system', 1, NULL, 0, 0)
ON CONFLICT (tenant_id, name) DO NOTHING;

INSERT INTO form_profiles
  (id, tenant_id, profile_key, display_name, description, form_kind, fields_json, localizations_json, is_active, is_system, created_at, updated_at)
VALUES
  (
    'form-registration-default',
    'default',
    'registration',
    'Registration',
    'Default registration form.',
    'registration',
    '[{"field":"auth.passkey","label":"Create Account with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10},{"field":"email","label":"Email","required":true,"block_type":"identity_field","order":20},{"field":"name","label":"Name","required":false,"block_type":"identity_field","order":30}]',
    NULL,
    1,
    1,
    0,
    0
  ),
  (
    'form-profile-completion-default',
    'default',
    'profile_completion',
    'Profile completion',
    'Default profile completion form.',
    'profile_completion',
    '[{"field":"name","label":"Name","required":true},{"field":"preferred_username","label":"Preferred username","required":false}]',
    NULL,
    1,
    1,
    0,
    0
  ),
  (
    'form-login-default',
    'default',
    'login',
    'Login',
    'Default login helper form.',
    'login',
    '[{"field":"email","label":"Email","required":false}]',
    NULL,
    1,
    1,
    0,
    0
  )
ON CONFLICT (tenant_id, profile_key) DO NOTHING;
