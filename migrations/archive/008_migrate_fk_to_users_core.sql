-- Migration: Update all FK constraints to reference users_core instead of users
-- This migration recreates tables to change FK references
-- SQLite doesn't support ALTER TABLE for FK modifications
--
-- Tables affected:
-- 1. sessions
-- 2. passkeys
-- 3. user_custom_fields
-- 4. password_reset_tokens
-- 5. user_roles
-- 6. oauth_client_consents
-- 7. ciba_requests
-- 8. subject_org_membership
-- 9. role_assignments
-- 10. linked_identities
-- 11. user_token_families

-- Disable FK constraints during migration
PRAGMA foreign_keys = OFF;

-- ============================================
-- 1. sessions
-- ============================================
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  external_provider_id TEXT,
  external_provider_sub TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO sessions_new SELECT * FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_tenant ON sessions(tenant_id);

-- ============================================
-- 2. passkeys
-- ============================================
CREATE TABLE passkeys_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO passkeys_new SELECT * FROM passkeys;
DROP TABLE passkeys;
ALTER TABLE passkeys_new RENAME TO passkeys;
CREATE INDEX idx_passkeys_user ON passkeys(user_id);
CREATE INDEX idx_passkeys_tenant ON passkeys(tenant_id);

-- ============================================
-- 3. user_custom_fields
-- ============================================
CREATE TABLE user_custom_fields_new (
  user_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  field_type TEXT,
  searchable INTEGER DEFAULT 1,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (user_id, field_name),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO user_custom_fields_new SELECT * FROM user_custom_fields;
DROP TABLE user_custom_fields;
ALTER TABLE user_custom_fields_new RENAME TO user_custom_fields;

-- ============================================
-- 4. password_reset_tokens
-- ============================================
CREATE TABLE password_reset_tokens_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO password_reset_tokens_new SELECT * FROM password_reset_tokens;
DROP TABLE password_reset_tokens;
ALTER TABLE password_reset_tokens_new RENAME TO password_reset_tokens;
CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id);

-- ============================================
-- 5. user_roles
-- ============================================
CREATE TABLE user_roles_new (
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);
INSERT INTO user_roles_new SELECT * FROM user_roles;
DROP TABLE user_roles;
ALTER TABLE user_roles_new RENAME TO user_roles;

-- ============================================
-- 6. oauth_client_consents
-- ============================================
CREATE TABLE oauth_client_consents_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  UNIQUE (user_id, client_id)
);
INSERT INTO oauth_client_consents_new SELECT * FROM oauth_client_consents;
DROP TABLE oauth_client_consents;
ALTER TABLE oauth_client_consents_new RENAME TO oauth_client_consents;
CREATE INDEX idx_consents_user ON oauth_client_consents(user_id);
CREATE INDEX idx_consents_client ON oauth_client_consents(client_id);

-- ============================================
-- 7. ciba_requests
-- ============================================
CREATE TABLE ciba_requests_new (
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
  FOREIGN KEY (client_id) REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO ciba_requests_new SELECT * FROM ciba_requests;
DROP TABLE ciba_requests;
ALTER TABLE ciba_requests_new RENAME TO ciba_requests;
CREATE INDEX idx_ciba_client ON ciba_requests(client_id);
CREATE INDEX idx_ciba_user ON ciba_requests(user_id);
CREATE INDEX idx_ciba_status ON ciba_requests(status);

-- ============================================
-- 8. subject_org_membership
-- ============================================
CREATE TABLE subject_org_membership_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  membership_type TEXT NOT NULL DEFAULT 'member',
  is_primary INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
INSERT INTO subject_org_membership_new SELECT * FROM subject_org_membership;
DROP TABLE subject_org_membership;
ALTER TABLE subject_org_membership_new RENAME TO subject_org_membership;
CREATE INDEX idx_membership_subject ON subject_org_membership(subject_id);
CREATE INDEX idx_membership_org ON subject_org_membership(org_id);

-- ============================================
-- 9. role_assignments
-- ============================================
CREATE TABLE role_assignments_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'global',
  scope_target TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  assigned_by TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (subject_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);
INSERT INTO role_assignments_new SELECT * FROM role_assignments;
DROP TABLE role_assignments;
ALTER TABLE role_assignments_new RENAME TO role_assignments;
CREATE INDEX idx_role_assignments_subject ON role_assignments(subject_id);
CREATE INDEX idx_role_assignments_role ON role_assignments(role_id);

-- ============================================
-- 10. linked_identities
-- ============================================
CREATE TABLE linked_identities_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  email_verified INTEGER DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at INTEGER,
  raw_claims TEXT,
  profile_data TEXT,
  linked_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);
INSERT INTO linked_identities_new SELECT * FROM linked_identities;
DROP TABLE linked_identities;
ALTER TABLE linked_identities_new RENAME TO linked_identities;
CREATE INDEX idx_linked_identities_user ON linked_identities(user_id);
CREATE INDEX idx_linked_identities_provider ON linked_identities(provider_id);

-- ============================================
-- 11. user_token_families
-- ============================================
CREATE TABLE user_token_families_new (
  jti TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  is_revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users_core(id) ON DELETE CASCADE
);
INSERT INTO user_token_families_new SELECT * FROM user_token_families;
DROP TABLE user_token_families;
ALTER TABLE user_token_families_new RENAME TO user_token_families;
CREATE INDEX idx_token_families_user ON user_token_families(user_id);
CREATE INDEX idx_token_families_client ON user_token_families(client_id);

-- Re-enable FK constraints
PRAGMA foreign_keys = ON;

-- Verify FK constraints are working
PRAGMA foreign_key_check;
