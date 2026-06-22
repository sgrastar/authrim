-- Consent policy restructure.
-- Separates consent document selection, assignment timing, client/SP trust,
-- and sign-in transition confirmation.

ALTER TABLE consent_statements ADD COLUMN record_retention_days INTEGER;
ALTER TABLE consent_statements ADD COLUMN withdrawal_allowed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE consent_statements ADD COLUMN withdrawal_impact TEXT;
ALTER TABLE consent_statements ADD COLUMN reconsent_on_version_change INTEGER NOT NULL DEFAULT 1;
ALTER TABLE consent_statements ADD COLUMN reconsent_interval_days INTEGER;

CREATE TABLE consent_policies (
  id TEXT PRIMARY KEY,
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
  id TEXT PRIMARY KEY,
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

CREATE TABLE consent_policy_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('registration', 'login', 'oidc_client', 'saml_sp')),
  target_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES consent_policies(id) ON DELETE CASCADE,
  UNIQUE (tenant_id, assignment_type, target_id)
);

CREATE TABLE client_trust_policies (
  id TEXT PRIMARY KEY,
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

CREATE TABLE sign_in_confirmation_policies (
  id TEXT PRIMARY KEY,
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

CREATE INDEX idx_consent_policy_items_policy
  ON consent_policy_items(tenant_id, policy_id, display_order);

CREATE INDEX idx_consent_policy_assignments_policy
  ON consent_policy_assignments(tenant_id, policy_id);

CREATE INDEX idx_client_trust_policies_target
  ON client_trust_policies(tenant_id, target_type, target_id);
