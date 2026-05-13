-- =============================================================================
-- Admin Machine Access
-- =============================================================================
-- Description: Adds DB_ADMIN tables for scoped machine access to Admin API using
--              client_credentials with private_key_jwt client authentication.

CREATE TABLE IF NOT EXISTS admin_machine_principals (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT,
  principal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  default_audience TEXT NOT NULL DEFAULT 'authrim:admin-api',
  token_ttl_seconds INTEGER NOT NULL DEFAULT 600,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  disabled_by_actor_type TEXT,
  disabled_by_actor_id TEXT,
  CHECK (principal_type IN (
    'setup_tool',
    'admin_ui_bff',
    'automation',
    'ci',
    'mcp_server',
    'ai_agent',
    'internal_service',
    'integration'
  )),
  CHECK (status IN ('active', 'disabled', 'deleted')),
  CHECK (token_ttl_seconds > 0 AND token_ttl_seconds <= 900)
);

CREATE TABLE IF NOT EXISTS admin_machine_credentials (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  kid TEXT NOT NULL,
  public_jwk_json TEXT NOT NULL,
  alg TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  not_before INTEGER,
  expires_at INTEGER,
  last_used_at INTEGER,
  last_used_ip TEXT,
  last_used_user_agent TEXT,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by_actor_type TEXT,
  revoked_by_actor_id TEXT,
  revoke_reason TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  UNIQUE (principal_id, kid),
  CHECK (status IN ('active', 'rotating', 'revoked', 'expired')),
  CHECK (alg IN ('ES256', 'PS256', 'RS256'))
);

CREATE TABLE IF NOT EXISTS admin_machine_principal_permissions (
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (principal_id, permission),
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_machine_credential_permissions (
  credential_id TEXT NOT NULL,
  permission TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  PRIMARY KEY (credential_id, permission),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_machine_principal_tenant_scopes (
  principal_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  CHECK (scope_mode IN ('none', 'all', 'allow')),
  CHECK (
    (scope_mode = 'allow' AND tenant_id IS NOT NULL)
    OR (scope_mode IN ('none', 'all') AND tenant_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS admin_machine_credential_tenant_scopes (
  credential_id TEXT NOT NULL,
  scope_mode TEXT NOT NULL,
  tenant_id TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE,
  CHECK (scope_mode IN ('none', 'all', 'allow')),
  CHECK (
    (scope_mode = 'allow' AND tenant_id IS NOT NULL)
    OR (scope_mode IN ('none', 'all') AND tenant_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS admin_machine_resource_scopes (
  id TEXT PRIMARY KEY,
  principal_id TEXT,
  credential_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  constraints_json TEXT,
  created_at INTEGER NOT NULL,
  created_by_actor_type TEXT,
  created_by_actor_id TEXT,
  FOREIGN KEY (principal_id) REFERENCES admin_machine_principals(id) ON DELETE CASCADE,
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE,
  CHECK (
    (principal_id IS NOT NULL AND credential_id IS NULL)
    OR (principal_id IS NULL AND credential_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS admin_machine_assertion_jti (
  client_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, credential_id, jti),
  FOREIGN KEY (credential_id) REFERENCES admin_machine_credentials(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_admin_machine_principals_status
  ON admin_machine_principals(status);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credentials_principal
  ON admin_machine_credentials(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credentials_status
  ON admin_machine_credentials(status);

CREATE INDEX IF NOT EXISTS idx_admin_machine_principal_tenant_scopes_principal
  ON admin_machine_principal_tenant_scopes(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_credential_tenant_scopes_credential
  ON admin_machine_credential_tenant_scopes(credential_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_resource_scopes_principal
  ON admin_machine_resource_scopes(principal_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_resource_scopes_credential
  ON admin_machine_resource_scopes(credential_id);

CREATE INDEX IF NOT EXISTS idx_admin_machine_assertion_jti_expires
  ON admin_machine_assertion_jti(expires_at);
