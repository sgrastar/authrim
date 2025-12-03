# Phase 7: Identity Hub Foundation

**Timeline:** 2025-12 ~ 2026-Q1
**Status:** ⏳ Starting

---

## Overview

Phase 7 transforms Authrim from an IdP-only solution into a full **Identity Hub** with Relying Party (RP) capabilities. This enables Authrim to accept authentication from external identity sources (Social Login, Enterprise IdPs, Wallets) and unify them into a single identity.

---

## Architecture Vision

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     External Identity Sources                            │
│   Google    GitHub    Microsoft    Apple    Facebook    Twitter    SAML │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       RP Module (Authrim as RP)                          │
│   • OIDC Client    • OAuth 2.0 Client    • SAML SP (existing)           │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Identity Linking & Stitching                        │
│   • Link multiple accounts to single user                               │
│   • Same-user detection logic (email, phone, verified attributes)       │
│   • Conflict resolution for duplicate claims                            │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Unified Identity (Authrim User)                      │
│   • Single user record with linked identities                           │
│   • Aggregated attributes from all sources                              │
│   • Normalized claims                                                   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 7.1 RP Module Foundation

Build the infrastructure for Authrim to act as a Relying Party:

### Upstream IdP Registry (D1) 🔜

Database schema and management for external identity providers:

- [ ] Design `upstream_providers` table schema
  ```sql
  CREATE TABLE upstream_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL, -- 'oidc', 'oauth2', 'saml'
    enabled BOOLEAN DEFAULT true,
    priority INTEGER DEFAULT 0,
    -- OIDC/OAuth2 specific
    issuer TEXT,
    client_id TEXT,
    client_secret_encrypted TEXT,
    authorization_endpoint TEXT,
    token_endpoint TEXT,
    userinfo_endpoint TEXT,
    jwks_uri TEXT,
    scopes TEXT, -- comma-separated
    -- SAML specific
    metadata_url TEXT,
    entity_id TEXT,
    -- Common
    attribute_mapping TEXT, -- JSON
    auto_link_email BOOLEAN DEFAULT true,
    jit_provisioning BOOLEAN DEFAULT true,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  ```
- [ ] Create `provider_credentials` table for secure credential storage
- [ ] Implement D1 migration script
- [ ] Add Admin API endpoints for provider CRUD
- [ ] Unit tests for provider storage

### OIDC RP Client 🔜

Implement OAuth 2.0 + OIDC client capabilities:

- [ ] Design `OIDCRPClient` class interface

  ```typescript
  interface OIDCRPClient {
    // Discovery
    discover(issuer: string): Promise<ProviderMetadata>;

    // Authorization
    createAuthorizationUrl(config: AuthConfig): string;
    handleCallback(code: string, state: string): Promise<TokenResponse>;

    // Token handling
    validateIdToken(token: string): Promise<Claims>;
    fetchUserInfo(accessToken: string): Promise<UserInfo>;

    // Token refresh
    refreshTokens(refreshToken: string): Promise<TokenResponse>;
  }
  ```

- [ ] Implement OIDC discovery (/.well-known/openid-configuration fetch)
- [ ] Implement PKCE for authorization flow
- [ ] Implement token exchange (code → tokens)
- [ ] Implement ID Token validation (signature, claims)
- [ ] Implement UserInfo endpoint call
- [ ] Add automatic token refresh
- [ ] Handle provider errors gracefully
- [ ] Unit tests (20+ tests)

### OAuth 2.0 RP Client 🔜

Support for OAuth 2.0-only providers (no OIDC):

- [ ] Design `OAuth2RPClient` class
- [ ] Implement authorization URL generation
- [ ] Implement token exchange
- [ ] Implement profile API calls (provider-specific)
- [ ] Handle provider-specific quirks
- [ ] Unit tests

### Session Linking 🔜

Link upstream sessions to Authrim sessions:

- [ ] Design `linked_identities` table
  ```sql
  CREATE TABLE linked_identities (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    provider_id TEXT NOT NULL REFERENCES upstream_providers(id),
    provider_user_id TEXT NOT NULL,
    provider_email TEXT,
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at TEXT,
    raw_claims TEXT, -- JSON of original claims
    linked_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_login TEXT,
    UNIQUE(provider_id, provider_user_id)
  );
  ```
- [ ] Implement session state management
- [ ] Handle session expiry and refresh
- [ ] Track last login per provider
- [ ] Unit tests

---

## 7.2 Social Login Providers

Implement specific provider integrations:

### Google (OIDC) 🔜 - High Priority

- [ ] Research Google OAuth 2.0 / OIDC endpoints
- [ ] Implement Google-specific configuration
- [ ] Handle Google scopes (profile, email, openid)
- [ ] Fetch Google profile (name, picture, email)
- [ ] Handle verified email check
- [ ] Integration tests with mock Google responses
- [ ] Document Google setup (Cloud Console steps)

### GitHub (OAuth 2.0) 🔜 - High Priority

- [ ] Research GitHub OAuth 2.0 endpoints
- [ ] Implement GitHub-specific configuration
- [ ] Handle GitHub scopes (read:user, user:email)
- [ ] Fetch GitHub profile (login, name, avatar_url)
- [ ] Handle private email fallback (GitHub API)
- [ ] Integration tests
- [ ] Document GitHub setup

### Microsoft Entra ID (OIDC) 🔜 - High Priority

- [ ] Research Microsoft Identity Platform endpoints
- [ ] Implement multi-tenant vs single-tenant support
- [ ] Handle Microsoft scopes (openid, profile, email)
- [ ] Fetch Microsoft profile
- [ ] Support organizations and personal accounts
- [ ] Integration tests
- [ ] Document Entra ID setup

### Apple (OIDC) 🔜 - Medium Priority

- [ ] Research Apple Sign In requirements
- [ ] Implement Apple-specific JWT client secret generation
- [ ] Handle Apple's private email relay
- [ ] Fetch Apple profile (note: limited data)
- [ ] Store refresh tokens (Apple requirement for 6+ months)
- [ ] Integration tests
- [ ] Document Apple setup (Developer Portal steps)

### Facebook (OAuth 2.0) 🔜 - Medium Priority

- [ ] Research Facebook Graph API endpoints
- [ ] Implement Facebook-specific configuration
- [ ] Handle Facebook permissions
- [ ] Fetch Facebook profile (id, name, email, picture)
- [ ] Handle app review requirements
- [ ] Integration tests
- [ ] Document Facebook setup

### Twitter/X (OAuth 2.0) 🔜 - Low Priority

- [ ] Research Twitter OAuth 2.0 with PKCE
- [ ] Implement Twitter-specific configuration
- [ ] Handle Twitter scopes (tweet.read, users.read)
- [ ] Fetch Twitter profile (username, name, profile_image_url)
- [ ] Integration tests
- [ ] Document Twitter setup

### LinkedIn (OAuth 2.0) 🔜 - Low Priority

- [ ] Research LinkedIn OAuth 2.0 endpoints
- [ ] Implement LinkedIn-specific configuration
- [ ] Handle LinkedIn scopes (r_liteprofile, r_emailaddress)
- [ ] Fetch LinkedIn profile
- [ ] Handle professional information claims
- [ ] Integration tests
- [ ] Document LinkedIn setup

---

## 7.3 Identity Linking & Stitching

Unify identities from multiple sources:

### Account Linking 🔜

Allow users to link multiple provider accounts:

- [ ] Design linking flow
  ```
  1. User logs in with Provider A → Authrim account created
  2. User clicks "Link Provider B"
  3. User authenticates with Provider B
  4. Provider B identity linked to existing account
  ```
- [ ] Implement "link new provider" endpoint
- [ ] Handle already-linked provider detection
- [ ] Add unlink functionality
- [ ] Track link history in audit log
- [ ] Unit tests

### Identity Stitching 🔜

Automatic same-user detection:

- [ ] Design stitching rules engine

  ```typescript
  interface StitchingRule {
    attribute: 'email' | 'phone' | 'custom';
    requireVerified: boolean;
    priority: number;
  }

  // Example: If verified email matches, auto-link
  const rules: StitchingRule[] = [
    { attribute: 'email', requireVerified: true, priority: 1 },
    { attribute: 'phone', requireVerified: true, priority: 2 },
  ];
  ```

- [ ] Implement email-based stitching (verified only)
- [ ] Implement phone-based stitching (verified only)
- [ ] Add configurable stitching rules
- [ ] Handle conflicts (prompt user)
- [ ] Unit tests (edge cases)

### Attribute Mapping 🔜

Map provider claims to Authrim schema:

- [ ] Design attribute mapping schema
  ```typescript
  interface AttributeMapping {
    provider_claim: string; // e.g., 'preferred_username'
    authrim_attribute: string; // e.g., 'nickname'
    transform?: 'lowercase' | 'uppercase' | 'normalize';
    overwrite: boolean; // Overwrite existing value?
  }
  ```
- [ ] Implement claim transformation pipeline
- [ ] Handle nested claim paths (e.g., `address.formatted`)
- [ ] Add default mappings per provider
- [ ] Admin UI for custom mappings
- [ ] Unit tests

### Conflict Resolution 🔜

Handle attribute conflicts across providers:

- [ ] Design conflict resolution strategy
  - [ ] Provider priority (higher priority wins)
  - [ ] Most recent wins
  - [ ] User choice
  - [ ] Merge (for arrays)
- [ ] Implement conflict detection
- [ ] Create conflict resolution UI
- [ ] Log conflicts for admin review
- [ ] Unit tests

---

## 7.4 Admin Console Enhancement

Extend admin dashboard for Identity Hub management:

### Provider Management UI 🔜

- [ ] List all upstream providers
- [ ] Add new provider wizard
  - [ ] OIDC provider setup
  - [ ] OAuth 2.0 provider setup
  - [ ] SAML provider setup (existing)
- [ ] Edit provider configuration
- [ ] Test provider connection
- [ ] Enable/disable providers
- [ ] Delete provider (with linked identity handling)
- [ ] View provider usage statistics

### Attribute Mapping UI 🔜

- [ ] Visual mapping editor
- [ ] Preview claim transformation
- [ ] Default mappings templates
- [ ] Import/export mappings
- [ ] Test with sample claims

### Login Flow Designer 🔜

- [ ] Configure provider display order
- [ ] Show/hide specific providers
- [ ] Group providers (Social vs Enterprise)
- [ ] Customize button styling per provider
- [ ] Preview login page appearance

---

## Database Migrations

### Migration 020: Upstream Providers

- [ ] Create `upstream_providers` table
- [ ] Create `linked_identities` table
- [ ] Create indexes for lookup performance
- [ ] Apply to dev/staging/production

### Migration 021: Stitching Rules

- [ ] Create `stitching_rules` table
- [ ] Create `attribute_mappings` table
- [ ] Add default rules seed data

---

## Testing Requirements

### Unit Tests

- [ ] OIDC RP Client tests (25+ tests)
- [ ] OAuth 2.0 RP Client tests (20+ tests)
- [ ] Identity linking tests (15+ tests)
- [ ] Attribute mapping tests (15+ tests)
- [ ] Stitching rules tests (20+ tests)

### Integration Tests

- [ ] Full login flow with mock providers
- [ ] Account linking flow
- [ ] Conflict resolution flow
- [ ] Provider management API tests

### E2E Tests (Playwright)

- [ ] Login with Social provider (mocked)
- [ ] Link additional provider
- [ ] Unlink provider
- [ ] Admin provider management

---

## Success Metrics

| Metric           | Target            | Current |
| ---------------- | ----------------- | ------- |
| Social providers | 7                 | 0       |
| RP Client tests  | 50+               | -       |
| Linking tests    | 30+               | -       |
| E2E tests        | 20+               | -       |
| Provider configs | Template for each | -       |

---

## Dependencies

- Phase 6 Complete ✅
- D1 Database available ✅
- KV Storage available ✅
- SAML SP already implemented ✅

---

## Related Documents

- [ROADMAP](../ROADMAP.md) - Overall product direction
- [TASKS_Phase6.md](./TASKS_Phase6.md) - Previous phase (Enterprise Features)
- [TASKS_Phase8.md](./TASKS_Phase8.md) - Next phase (Unified Policy Integration)
- [Database Schema](../architecture/database-schema.md)

---

> **Last Update**: 2025-12-03 (Phase 7 definition for Identity Hub Foundation)
