-- =============================================================================
-- Authrim External Postgres Migration 003: Consent, Screens, and OIDC Scopes
-- Consolidated for fresh Authrim installs from migrations/external/postgres/003_external_consent_audit_snapshots.sql, migrations/external/postgres/010_drop_legacy_consent_policy_assignments.sql, migrations/external/postgres/011_external_consent_records_screens_scopes.sql, migrations/external/postgres/012_external_screen_settings.sql, migrations/external/postgres/014_external_screens_consent_kind.sql, migrations/external/postgres/016_external_consent_canonical_user_ids.sql, migrations/external/postgres/018_external_screens_code_input_kind.sql.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/003_external_consent_audit_snapshots.sql
-- -----------------------------------------------------------------------------

-- Persist consent audit snapshot deadlines for external durable core storage.

ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS retain_until BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS consent_settings_snapshot_at BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS record_retention_days_snapshot BIGINT;
ALTER TABLE user_consent_records ADD COLUMN IF NOT EXISTS reconsent_interval_days_snapshot BIGINT;

CREATE INDEX IF NOT EXISTS idx_user_consent_records_retain_until
  ON user_consent_records(retain_until);

CREATE TABLE IF NOT EXISTS consent_item_history (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  action TEXT NOT NULL,
  version_id_before TEXT,
  version_id_after TEXT,
  version_before TEXT,
  version_after TEXT,
  status_before TEXT,
  status_after TEXT,
  granted_at BIGINT,
  withdrawn_at BIGINT,
  expires_at BIGINT,
  retain_until BIGINT,
  consent_settings_snapshot_at BIGINT,
  record_retention_days_snapshot BIGINT,
  reconsent_interval_days_snapshot BIGINT,
  ip_address_hash TEXT,
  user_agent TEXT,
  client_id TEXT,
  metadata_json TEXT,
  created_at BIGINT NOT NULL
);

ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS version_id_before TEXT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS version_id_after TEXT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS granted_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS withdrawn_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS expires_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS retain_until BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS consent_settings_snapshot_at BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS record_retention_days_snapshot BIGINT;
ALTER TABLE consent_item_history ADD COLUMN IF NOT EXISTS reconsent_interval_days_snapshot BIGINT;

CREATE INDEX IF NOT EXISTS idx_consent_item_history_user
  ON consent_item_history(tenant_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_statement
  ON consent_item_history(statement_id, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_item_history_retain_until
  ON consent_item_history(retain_until);

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/010_drop_legacy_consent_policy_assignments.sql
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS consent_policy_assignments;

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/011_external_consent_records_screens_scopes.sql
-- -----------------------------------------------------------------------------

-- External durable schema for Consent records, Screen profiles, and OIDC Scope master.

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
  selected_options_json JSONB,
  released_scopes_json JSONB,
  released_claims_json JSONB,
  released_attributes_json JSONB,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'revoked', 'expired', 'superseded')
  ),
  expires_at BIGINT,
  revoked_at BIGINT,
  evidence_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
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
  fields_json JSONB NOT NULL,
  localizations_json JSONB,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
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
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  localizations_json JSONB,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_oidc_scopes_enabled
  ON oidc_scopes(tenant_id, enabled, name);

INSERT INTO oidc_scopes
  (id, tenant_id, name, display_name, description, scope_type, enabled, localizations_json, created_at, updated_at)
VALUES
  ('scope-openid-default', 'default', 'openid', 'OpenID', 'Sign in with an OpenID Connect identity.', 'system', TRUE, NULL, 0, 0),
  ('scope-profile-default', 'default', 'profile', 'Profile', 'Access basic profile claims such as name and preferred username.', 'system', TRUE, NULL, 0, 0),
  ('scope-email-default', 'default', 'email', 'Email', 'Access email address and email verification status.', 'system', TRUE, NULL, 0, 0)
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
    '[{"field":"heading.registration","label":"Create your account","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Create Account with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10}]'::jsonb,
    '{"en":{"fields":{"heading.registration-0":{"label":"Create your account"}}},"ja":{"fields":{"heading.registration-0":{"label":"アカウントを作成"}}},"zh_CN":{"fields":{"heading.registration-0":{"label":"创建你的账户"}}},"zh_TW":{"fields":{"heading.registration-0":{"label":"建立你的帳戶"}}},"es":{"fields":{"heading.registration-0":{"label":"Crea tu cuenta"}}},"pt":{"fields":{"heading.registration-0":{"label":"Crie sua conta"}}},"fr":{"fields":{"heading.registration-0":{"label":"Créez votre compte"}}},"de":{"fields":{"heading.registration-0":{"label":"Konto erstellen"}}},"ko":{"fields":{"heading.registration-0":{"label":"계정 만들기"}}},"ru":{"fields":{"heading.registration-0":{"label":"Создайте учетную запись"}}},"id":{"fields":{"heading.registration-0":{"label":"Buat akun Anda"}}}}'::jsonb,
    TRUE,
    TRUE,
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
    '[{"field":"name","label":"Name","required":true},{"field":"preferred_username","label":"Preferred username","required":false}]'::jsonb,
    NULL,
    TRUE,
    TRUE,
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
    '[{"field":"heading.login","label":"Sign in","required":false,"block_type":"heading","order":0},{"field":"auth.passkey","label":"Sign in with Passkey","required":false,"block_type":"auth_widget","auth_method":"passkey","order":10},{"field":"divider.or","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"mail_otp"},"order":20},{"field":"auth.mail_otp","label":"Send code by email","required":false,"block_type":"auth_widget","auth_method":"mail_otp","order":30},{"field":"auth.totp","label":"Sign in with authenticator app","required":false,"block_type":"auth_widget","auth_method":"totp","order":35},{"field":"divider.other_accounts","label":"Continue with another account","required":false,"block_type":"divider","text":"Continue with another account","display_condition":{"mode":"feature_enabled","feature":"external_idp"},"order":40},{"field":"auth.external_idp","label":"Ext. IdP","required":false,"block_type":"auth_widget","auth_method":"external_idp","external_idp_show_action_text":false,"order":50},{"field":"divider.directory_password","label":"or","required":false,"block_type":"divider","text":"or","display_condition":{"mode":"feature_enabled","feature":"directory_password"},"order":55},{"field":"auth.directory_password","label":"Sign in with directory password","required":false,"block_type":"auth_widget","auth_method":"directory_password","order":60}]'::jsonb,
    '{"en":{"fields":{"heading.login-0":{"label":"Sign in"}}},"ja":{"fields":{"heading.login-0":{"label":"ログイン"}}},"zh_CN":{"fields":{"heading.login-0":{"label":"登录"}}},"zh_TW":{"fields":{"heading.login-0":{"label":"登入"}}},"es":{"fields":{"heading.login-0":{"label":"Iniciar sesión"}}},"pt":{"fields":{"heading.login-0":{"label":"Entrar"}}},"fr":{"fields":{"heading.login-0":{"label":"Se connecter"}}},"de":{"fields":{"heading.login-0":{"label":"Anmelden"}}},"ko":{"fields":{"heading.login-0":{"label":"로그인"}}},"ru":{"fields":{"heading.login-0":{"label":"Войти"}}},"id":{"fields":{"heading.login-0":{"label":"Masuk"}}}}'::jsonb,
    TRUE,
    TRUE,
    0,
    0
  )
ON CONFLICT (tenant_id, screen_key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/012_external_screen_settings.sql
-- -----------------------------------------------------------------------------

ALTER TABLE screens ADD COLUMN IF NOT EXISTS settings_json JSONB;

UPDATE screens
SET settings_json = '{"canvas_layout":"narrow"}'::jsonb
WHERE settings_json IS NULL;

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/014_external_screens_consent_kind.sql
-- -----------------------------------------------------------------------------

-- Allow reusable consent screens to be managed with other screen profiles.

ALTER TABLE screens
  DROP CONSTRAINT IF EXISTS screens_screen_kind_check;

ALTER TABLE screens
  ADD CONSTRAINT screens_screen_kind_check
  CHECK (screen_kind IN ('registration', 'profile_completion', 'login', 'consent', 'custom'));

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/016_external_consent_canonical_user_ids.sql
-- -----------------------------------------------------------------------------

-- Allow consent records to use canonical runtime user IDs.
--
-- Runtime users are represented by identity_accounts.legacy_user_id. Consent tables store that
-- stable runtime user ID and must not require a legacy users_core row to exist.

ALTER TABLE oauth_client_consents
  DROP CONSTRAINT IF EXISTS oauth_client_consents_user_fk;

ALTER TABLE user_consent_records
  DROP CONSTRAINT IF EXISTS user_consent_records_user_fk;

-- -----------------------------------------------------------------------------
-- Source: migrations/external/postgres/018_external_screens_code_input_kind.sql
-- -----------------------------------------------------------------------------

-- Allow dedicated code input screens to be managed with other screen profiles.

ALTER TABLE screens
  DROP CONSTRAINT IF EXISTS screens_screen_kind_check;

ALTER TABLE screens
  ADD CONSTRAINT screens_screen_kind_check
  CHECK (screen_kind IN ('registration', 'profile_completion', 'login', 'consent', 'code_input', 'custom'));

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
    '[{"field":"heading.code_input","label":"Enter verification code","required":false,"block_type":"heading","order":0},{"field":"auth.code_input","label":"Authentication code","required":true,"block_type":"code_input_widget","auth_method":"mail_otp","code_input_mode":"auto","text":"Enter the code from your email or authenticator app.","order":10}]'::jsonb,
    '{"en":{"fields":{"heading.code_input-0":{"label":"Enter verification code"}}},"ja":{"fields":{"heading.code_input-0":{"label":"認証コードを入力"}}},"zh_CN":{"fields":{"heading.code_input-0":{"label":"输入验证码"}}},"zh_TW":{"fields":{"heading.code_input-0":{"label":"輸入驗證碼"}}},"es":{"fields":{"heading.code_input-0":{"label":"Introduce el código de verificación"}}},"pt":{"fields":{"heading.code_input-0":{"label":"Insira o código de verificação"}}},"fr":{"fields":{"heading.code_input-0":{"label":"Saisissez le code de vérification"}}},"de":{"fields":{"heading.code_input-0":{"label":"Bestätigungscode eingeben"}}},"ko":{"fields":{"heading.code_input-0":{"label":"인증 코드를 입력하세요"}}},"ru":{"fields":{"heading.code_input-0":{"label":"Введите код подтверждения"}}},"id":{"fields":{"heading.code_input-0":{"label":"Masukkan kode verifikasi"}}}}'::jsonb,
    '{"canvas_layout":"narrow"}'::jsonb,
    TRUE,
    TRUE,
    0,
    0
  )
ON CONFLICT (tenant_id, screen_key) DO NOTHING;
