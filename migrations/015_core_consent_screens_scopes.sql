-- =============================================================================
-- Authrim Core Migration 015: Consent, Screens, and OIDC Scopes
-- Consolidated for fresh Authrim installs from migrations/016_consent_policy_restructure.sql, migrations/017_consent_statement_version_end_time.sql, migrations/018_consent_localization_user_facing_fields.sql, migrations/019_consent_audit_snapshots.sql, migrations/028_drop_legacy_consent_policy_assignments.sql, migrations/029_consent_records_screens_scopes.sql, migrations/030_screen_settings.sql, migrations/032_screens_consent_kind.sql, migrations/034_consent_canonical_user_ids.sql, migrations/036_screens_code_input_kind.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/016_consent_policy_restructure.sql
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- Source: migrations/017_consent_statement_version_end_time.sql
-- -----------------------------------------------------------------------------

-- Add optional end time for consent statement versions.

ALTER TABLE consent_statement_versions ADD COLUMN effective_until INTEGER;

-- -----------------------------------------------------------------------------
-- Source: migrations/018_consent_localization_user_facing_fields.sql
-- -----------------------------------------------------------------------------

-- Add localized user-facing consent explanation fields.

ALTER TABLE consent_statement_localizations ADD COLUMN processing_purpose TEXT;
ALTER TABLE consent_statement_localizations ADD COLUMN withdrawal_impact TEXT;

-- -----------------------------------------------------------------------------
-- Source: migrations/019_consent_audit_snapshots.sql
-- -----------------------------------------------------------------------------

-- Persist consent audit snapshot deadlines at the time of each user decision.

ALTER TABLE user_consent_records ADD COLUMN retain_until INTEGER;
ALTER TABLE user_consent_records ADD COLUMN consent_settings_snapshot_at INTEGER;
ALTER TABLE user_consent_records ADD COLUMN record_retention_days_snapshot INTEGER;
ALTER TABLE user_consent_records ADD COLUMN reconsent_interval_days_snapshot INTEGER;

ALTER TABLE consent_item_history ADD COLUMN version_id_before TEXT;
ALTER TABLE consent_item_history ADD COLUMN version_id_after TEXT;
ALTER TABLE consent_item_history ADD COLUMN granted_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN expires_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN retain_until INTEGER;
ALTER TABLE consent_item_history ADD COLUMN consent_settings_snapshot_at INTEGER;
ALTER TABLE consent_item_history ADD COLUMN record_retention_days_snapshot INTEGER;
ALTER TABLE consent_item_history ADD COLUMN reconsent_interval_days_snapshot INTEGER;

CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);
CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);

-- -----------------------------------------------------------------------------
-- Source: migrations/028_drop_legacy_consent_policy_assignments.sql
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS consent_policy_assignments;

-- -----------------------------------------------------------------------------
-- Source: migrations/029_consent_records_screens_scopes.sql
-- -----------------------------------------------------------------------------

-- Consent records, Screen profiles, and OIDC Scope master.
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

CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN ('registration', 'profile_completion', 'login', 'custom')
  ),
  fields_json TEXT NOT NULL,
  localizations_json TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (tenant_id, screen_key)
);

CREATE INDEX IF NOT EXISTS idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);

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

INSERT INTO screens
  (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json, localizations_json, is_active, is_system, created_at, updated_at)
VALUES
  (
    'screen-registration-default',
    'default',
    'registration',
    'Registration',
    'Default registration screen.',
    'registration',
    '[{"field":"heading.registration","label":"Create your account","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Create Account with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10}]',
    '{"en":{"fields":{"heading.registration-0":{"label":"Create your account"}}},"ja":{"fields":{"heading.registration-0":{"label":"アカウントを作成"}}},"zh_CN":{"fields":{"heading.registration-0":{"label":"创建你的账户"}}},"zh_TW":{"fields":{"heading.registration-0":{"label":"建立你的帳戶"}}},"es":{"fields":{"heading.registration-0":{"label":"Crea tu cuenta"}}},"pt":{"fields":{"heading.registration-0":{"label":"Crie sua conta"}}},"fr":{"fields":{"heading.registration-0":{"label":"Créez votre compte"}}},"de":{"fields":{"heading.registration-0":{"label":"Konto erstellen"}}},"ko":{"fields":{"heading.registration-0":{"label":"계정 만들기"}}},"ru":{"fields":{"heading.registration-0":{"label":"Создайте учетную запись"}}},"id":{"fields":{"heading.registration-0":{"label":"Buat akun Anda"}}}}',
    1,
    1,
    0,
    0
  ),
  (
    'screen-profile-completion-default',
    'default',
    'profile_completion',
    'Profile completion',
    'Default profile completion screen.',
    'profile_completion',
    '[{"field":"name","label":"Name","required":true},{"field":"preferred_username","label":"Preferred username","required":false}]',
    NULL,
    1,
    1,
    0,
    0
  ),
  (
    'screen-login-default',
    'default',
    'login',
    'Login',
    'Default login screen.',
    'login',
    '[{"field":"heading.login","label":"Sign in","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Sign in with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10},{"field":"divider.or","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"mail_otp"},"order":20},{"field":"auth.mail_otp","label":"Send code by email","required":false,"block_type":"auth_widget","auth_method":"mail_otp","order":30},{"field":"auth.totp","label":"Sign in with authenticator app","required":false,"block_type":"auth_widget","auth_method":"totp","order":35},{"field":"divider.other_accounts","label":"Continue with another account","required":false,"block_type":"divider","text":"Continue with another account","display_condition":{"mode":"feature_enabled","feature":"external_idp"},"order":40},{"field":"auth.external_idp","label":"Ext. IdP","required":false,"block_type":"auth_widget","auth_method":"external_idp","external_idp_show_action_text":false,"order":50},{"field":"divider.directory_password","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"directory_password"},"order":55},{"field":"auth.directory_password","label":"Sign in with directory password","required":false,"block_type":"auth_widget","auth_method":"directory_password","order":60}]',
    '{"en":{"fields":{"heading.login-0":{"label":"Sign in"}}},"ja":{"fields":{"heading.login-0":{"label":"ログイン"}}},"zh_CN":{"fields":{"heading.login-0":{"label":"登录"}}},"zh_TW":{"fields":{"heading.login-0":{"label":"登入"}}},"es":{"fields":{"heading.login-0":{"label":"Iniciar sesión"}}},"pt":{"fields":{"heading.login-0":{"label":"Entrar"}}},"fr":{"fields":{"heading.login-0":{"label":"Se connecter"}}},"de":{"fields":{"heading.login-0":{"label":"Anmelden"}}},"ko":{"fields":{"heading.login-0":{"label":"로그인"}}},"ru":{"fields":{"heading.login-0":{"label":"Войти"}}},"id":{"fields":{"heading.login-0":{"label":"Masuk"}}}}',
    1,
    1,
    0,
    0
  )
ON CONFLICT (tenant_id, screen_key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Source: migrations/030_screen_settings.sql
-- -----------------------------------------------------------------------------

ALTER TABLE screens ADD COLUMN settings_json TEXT;

UPDATE screens
SET settings_json = '{"canvas_layout":"narrow"}'
WHERE settings_json IS NULL;

-- -----------------------------------------------------------------------------
-- Source: migrations/032_screens_consent_kind.sql
-- -----------------------------------------------------------------------------

-- Allow reusable consent screens to be managed with other screen profiles.
-- SQLite/D1 cannot alter CHECK constraints in place, so rebuild the table.

CREATE TABLE screens_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN ('registration', 'profile_completion', 'login', 'consent', 'custom')
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

INSERT INTO screens_new
  (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
   localizations_json, settings_json, is_active, is_system, created_at, updated_at)
SELECT
  id,
  tenant_id,
  screen_key,
  display_name,
  description,
  screen_kind,
  fields_json,
  localizations_json,
  COALESCE(settings_json, '{"canvas_layout":"narrow"}'),
  is_active,
  is_system,
  created_at,
  updated_at
FROM screens;

DROP TABLE screens;

ALTER TABLE screens_new RENAME TO screens;

CREATE INDEX IF NOT EXISTS idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);

-- -----------------------------------------------------------------------------
-- Source: migrations/034_consent_canonical_user_ids.sql
-- -----------------------------------------------------------------------------

-- Allow consent records to use canonical runtime user IDs.
--
-- Runtime users now live in identity_accounts / identity_subjects. The user_id stored in
-- consent tables remains the stable runtime legacy_user_id, but users_core rows may no longer
-- exist. Rebuild the SQLite tables to remove legacy users_core foreign keys while preserving
-- client and consent statement constraints.

PRAGMA foreign_keys = OFF;

CREATE TABLE oauth_client_consents_new (
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
  FOREIGN KEY (tenant_id, client_id) REFERENCES oauth_clients(tenant_id, client_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id, client_id)
);

INSERT INTO oauth_client_consents_new (
  id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at, tenant_id,
  selected_scopes, privacy_policy_version, tos_version, consent_version
)
SELECT
  id, user_id, client_id, scope, granted_at, expires_at, created_at, updated_at, tenant_id,
  selected_scopes, privacy_policy_version, tos_version, consent_version
FROM oauth_client_consents;

DROP TABLE oauth_client_consents;
ALTER TABLE oauth_client_consents_new RENAME TO oauth_client_consents;

CREATE INDEX idx_consents_client ON oauth_client_consents(tenant_id, client_id);
CREATE INDEX idx_consents_expires_at_active ON oauth_client_consents(expires_at);
CREATE INDEX idx_consents_user ON oauth_client_consents(tenant_id, user_id);

CREATE TABLE user_consent_records_new (
  id TEXT PRIMARY KEY,
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
  reconsent_interval_days_snapshot INTEGER,
  FOREIGN KEY (statement_id) REFERENCES consent_statements(id),
  FOREIGN KEY (version_id) REFERENCES consent_statement_versions(id),
  UNIQUE (tenant_id, user_id, statement_id)
);

INSERT INTO user_consent_records_new (
  id, tenant_id, user_id, statement_id, version_id, version, status, granted_at, withdrawn_at,
  expires_at, client_id, ip_address_hash, user_agent, receipt_id, created_at, updated_at,
  retain_until, consent_settings_snapshot_at, record_retention_days_snapshot,
  reconsent_interval_days_snapshot
)
SELECT
  id, tenant_id, user_id, statement_id, version_id, version, status, granted_at, withdrawn_at,
  expires_at, client_id, ip_address_hash, user_agent, receipt_id, created_at, updated_at,
  retain_until, consent_settings_snapshot_at, record_retention_days_snapshot,
  reconsent_interval_days_snapshot
FROM user_consent_records;

DROP TABLE user_consent_records;
ALTER TABLE user_consent_records_new RENAME TO user_consent_records;

CREATE INDEX idx_ucr_expires ON user_consent_records(expires_at);
CREATE INDEX idx_ucr_retain_until ON user_consent_records(retain_until);
CREATE INDEX idx_ucr_statement ON user_consent_records(tenant_id, statement_id);
CREATE INDEX idx_ucr_status ON user_consent_records(status);
CREATE INDEX idx_ucr_user ON user_consent_records(tenant_id, user_id);

CREATE TABLE consent_item_history_new (
  id TEXT PRIMARY KEY,
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
);

INSERT INTO consent_item_history_new (
  id, tenant_id, user_id, statement_id, action, version_before, version_after, status_before,
  status_after, ip_address_hash, user_agent, client_id, metadata_json, created_at,
  version_id_before, version_id_after, granted_at, withdrawn_at, expires_at, retain_until,
  consent_settings_snapshot_at, record_retention_days_snapshot, reconsent_interval_days_snapshot
)
SELECT
  id, tenant_id, user_id, statement_id, action, version_before, version_after, status_before,
  status_after, ip_address_hash, user_agent, client_id, metadata_json, created_at,
  version_id_before, version_id_after, granted_at, withdrawn_at, expires_at, retain_until,
  consent_settings_snapshot_at, record_retention_days_snapshot, reconsent_interval_days_snapshot
FROM consent_item_history;

DROP TABLE consent_item_history;
ALTER TABLE consent_item_history_new RENAME TO consent_item_history;

CREATE INDEX idx_cih_retain_until ON consent_item_history(retain_until);
CREATE INDEX idx_cih_statement ON consent_item_history(statement_id, created_at);
CREATE INDEX idx_cih_tenant ON consent_item_history(tenant_id, created_at);
CREATE INDEX idx_cih_user ON consent_item_history(tenant_id, user_id, created_at);

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Source: migrations/036_screens_code_input_kind.sql
-- -----------------------------------------------------------------------------

-- Allow dedicated code input screens to be managed with other screen profiles.
-- SQLite/D1 cannot alter CHECK constraints in place, so rebuild the table.

CREATE TABLE screens_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  screen_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  screen_kind TEXT NOT NULL CHECK (
    screen_kind IN ('registration', 'profile_completion', 'login', 'consent', 'code_input', 'custom')
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

INSERT INTO screens_new
  (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
   localizations_json, settings_json, is_active, is_system, created_at, updated_at)
SELECT
  id,
  tenant_id,
  screen_key,
  display_name,
  description,
  screen_kind,
  fields_json,
  localizations_json,
  COALESCE(settings_json, '{"canvas_layout":"narrow"}'),
  is_active,
  is_system,
  created_at,
  updated_at
FROM screens;

DROP TABLE screens;

ALTER TABLE screens_new RENAME TO screens;

CREATE INDEX IF NOT EXISTS idx_screens_kind
  ON screens(tenant_id, screen_kind, is_active);

INSERT INTO screens
  (id, tenant_id, screen_key, display_name, description, screen_kind, fields_json,
   localizations_json, settings_json, is_active, is_system, created_at, updated_at)
VALUES
  (
    'screen-code-input-default',
    'default',
    'code_input',
    'Code input',
    'Default code input screen.',
    'code_input',
    '[{"field":"heading.code_input","label":"Enter verification code","required":false,"block_type":"heading","order":0},{"field":"auth.code_input","label":"Authentication code","required":true,"block_type":"code_input_widget","auth_method":"mail_otp","code_input_mode":"auto","text":"Enter the code from your email or authenticator app.","order":10}]',
    '{"en":{"fields":{"heading.code_input-0":{"label":"Enter verification code"}}},"ja":{"fields":{"heading.code_input-0":{"label":"認証コードを入力"}}},"zh_CN":{"fields":{"heading.code_input-0":{"label":"输入验证码"}}},"zh_TW":{"fields":{"heading.code_input-0":{"label":"輸入驗證碼"}}},"es":{"fields":{"heading.code_input-0":{"label":"Introduce el código de verificación"}}},"pt":{"fields":{"heading.code_input-0":{"label":"Insira o código de verificação"}}},"fr":{"fields":{"heading.code_input-0":{"label":"Saisissez le code de vérification"}}},"de":{"fields":{"heading.code_input-0":{"label":"Bestätigungscode eingeben"}}},"ko":{"fields":{"heading.code_input-0":{"label":"인증 코드를 입력하세요"}}},"ru":{"fields":{"heading.code_input-0":{"label":"Введите код подтверждения"}}},"id":{"fields":{"heading.code_input-0":{"label":"Masukkan kode verifikasi"}}}}',
    '{"canvas_layout":"narrow"}',
    1,
    1,
    0,
    0
  )
ON CONFLICT (tenant_id, screen_key) DO NOTHING;
