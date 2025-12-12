-- Migration: 020_external_idp_providers.sql
-- Description: Create tables for external IdP integration (Phase 7: Identity Hub)
-- Author: Claude
-- Date: 2025-12-03

-- =============================================================================
-- 1. Upstream Providers Table
-- =============================================================================
-- Stores OIDC/OAuth2 provider configurations (Google, GitHub, Microsoft, etc.)

CREATE TABLE IF NOT EXISTS upstream_providers (
  id TEXT PRIMARY KEY,
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
  button_color TEXT,                     -- Brand color for login button (hex)
  button_text TEXT,                      -- Custom button text (optional)

  -- Metadata
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upstream_providers_tenant_id
  ON upstream_providers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_upstream_providers_enabled
  ON upstream_providers(tenant_id, enabled);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_providers_tenant_name
  ON upstream_providers(tenant_id, name);

-- =============================================================================
-- 2. Linked Identities Table
-- =============================================================================
-- Links external provider identities to Authrim users

CREATE TABLE IF NOT EXISTS linked_identities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL,                 -- References users(id)
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  provider_user_id TEXT NOT NULL,        -- sub claim from provider
  provider_email TEXT,                   -- Email from provider (for stitching)
  email_verified INTEGER DEFAULT 0,      -- Was email verified at provider?

  -- Token storage (encrypted with RP_TOKEN_ENCRYPTION_KEY)
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at INTEGER,

  -- Raw data
  raw_claims TEXT,                       -- JSON of original claims from provider
  profile_data TEXT,                     -- JSON of normalized profile

  -- Timestamps
  linked_at INTEGER NOT NULL,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL,

  -- Constraints
  UNIQUE(provider_id, provider_user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_linked_identities_tenant_id
  ON linked_identities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_user_id
  ON linked_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_id
  ON linked_identities(provider_id);
CREATE INDEX IF NOT EXISTS idx_linked_identities_provider_email
  ON linked_identities(provider_email);
CREATE INDEX IF NOT EXISTS idx_linked_identities_user_provider
  ON linked_identities(user_id, provider_id);

-- =============================================================================
-- 3. External IdP Auth States Table
-- =============================================================================
-- Tracks OAuth state parameters for CSRF protection and PKCE

CREATE TABLE IF NOT EXISTS external_idp_auth_states (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider_id TEXT NOT NULL,             -- References upstream_providers(id)
  state TEXT UNIQUE NOT NULL,            -- OAuth state parameter
  nonce TEXT,                            -- OIDC nonce for ID token validation
  code_verifier TEXT,                    -- PKCE code verifier
  redirect_uri TEXT NOT NULL,            -- Where to redirect after auth

  -- For linking flow
  user_id TEXT,                          -- Set if linking to existing account
  session_id TEXT,                       -- Authrim session (for linking flow)

  -- For OIDC proxy flow (future)
  original_auth_request TEXT,            -- JSON of original OIDC auth request

  -- Timestamps
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,

  FOREIGN KEY (provider_id) REFERENCES upstream_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_state
  ON external_idp_auth_states(state);
CREATE INDEX IF NOT EXISTS idx_external_idp_auth_states_expires_at
  ON external_idp_auth_states(expires_at);

-- =============================================================================
-- 4. Seed Google Provider (commented out - configure via Admin API)
-- =============================================================================
-- Uncomment and customize to seed Google provider:
--
-- INSERT INTO upstream_providers (
--   id, tenant_id, name, provider_type, enabled, priority,
--   issuer, client_id, client_secret_encrypted, scopes,
--   icon_url, button_color,
--   created_at, updated_at
-- ) VALUES (
--   'google',
--   'default',
--   'Google',
--   'oidc',
--   1,
--   0,
--   'https://accounts.google.com',
--   'YOUR_GOOGLE_CLIENT_ID',
--   'YOUR_ENCRYPTED_CLIENT_SECRET',
--   'openid email profile',
--   'https://www.google.com/favicon.ico',
--   '#4285F4',
--   unixepoch(),
--   unixepoch()
-- );
