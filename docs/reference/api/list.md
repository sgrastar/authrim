# Authrim API Endpoints List

**Last Updated**: 2025-12-26
**Total Endpoints**: 160+

This document provides a concise list of all available API endpoints in Authrim OIDC Provider.

> **Complete Reference**: See `private/docs/url-structure.csv` for the authoritative endpoint list.

---

## OIDC Discovery

| Method | Endpoint                            | Worker       | Description                             |
| ------ | ----------------------------------- | ------------ | --------------------------------------- |
| GET    | `/.well-known/openid-configuration` | ar-discovery | OpenID Connect discovery document       |
| GET    | `/.well-known/jwks.json`            | ar-discovery | JSON Web Key Set for token verification |

---

## OIDC Core

| Method    | Endpoint     | Worker      | Description                                                          |
| --------- | ------------ | ----------- | -------------------------------------------------------------------- |
| GET, POST | `/authorize` | ar-auth     | OAuth 2.0/OIDC authorization endpoint                                |
| POST      | `/token`     | ar-token    | Token endpoint for exchanging authorization codes and refresh tokens |
| GET, POST | `/userinfo`  | ar-userinfo | User information endpoint (requires access token)                    |

---

## OIDC Extensions

| Method | Endpoint      | Worker        | Description                             |
| ------ | ------------- | ------------- | --------------------------------------- |
| POST   | `/par`        | ar-auth       | Pushed Authorization Request (RFC 9126) |
| POST   | `/register`   | ar-management | Dynamic Client Registration (RFC 7591)  |
| POST   | `/introspect` | ar-management | Token introspection (RFC 7662)          |
| POST   | `/revoke`     | ar-management | Token revocation (RFC 7009)             |

---

## Device Flow (RFC 8628)

| Method | Endpoint                | Worker   | Description                                                                            |
| ------ | ----------------------- | -------- | -------------------------------------------------------------------------------------- |
| POST   | `/device_authorization` | ar-async | Initiate device authorization flow, returns device code and user code                  |
| GET    | `/device`               | ar-async | Device verification page (minimal HTML for conformance, redirects to UI in production) |
| POST   | `/api/devices/verify`   | ar-async | Verify and approve/deny device code (headless JSON API)                                |
| POST   | `/token`                | ar-token | Token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code`          |

---

## CIBA (Client Initiated Backchannel Authentication)

| Method | Endpoint                          | Worker   | Description                |
| ------ | --------------------------------- | -------- | -------------------------- |
| POST   | `/bc-authorize`                   | ar-async | CIBA authorization         |
| GET    | `/api/ciba/pending`               | ar-async | List pending CIBA requests |
| GET    | `/api/ciba/requests/:auth_req_id` | ar-async | Get CIBA request details   |
| POST   | `/api/ciba/approve`               | ar-async | Approve CIBA request       |
| POST   | `/api/ciba/deny`                  | ar-async | Deny CIBA request          |

---

## Internal Flow (HTML)

| Method    | Endpoint        | Worker  | Description                                        |
| --------- | --------------- | ------- | -------------------------------------------------- |
| GET, POST | `/flow/login`   | ar-auth | Login form (HTML) - OIDC authorize collision avoid |
| GET, POST | `/flow/confirm` | ar-auth | Consent confirm form (HTML)                        |

---

## Authentication APIs

### Passkey (WebAuthn/FIDO2)

| Method | Endpoint                              | Worker  | Description                              |
| ------ | ------------------------------------- | ------- | ---------------------------------------- |
| POST   | `/api/auth/passkeys/register/options` | ar-auth | Generate passkey registration options    |
| POST   | `/api/auth/passkeys/register/verify`  | ar-auth | Verify and complete passkey registration |
| POST   | `/api/auth/passkeys/login/options`    | ar-auth | Generate passkey authentication options  |
| POST   | `/api/auth/passkeys/login/verify`     | ar-auth | Verify passkey authentication response   |

### Email Code (Magic Link)

| Method | Endpoint                       | Worker  | Description             |
| ------ | ------------------------------ | ------- | ----------------------- |
| POST   | `/api/auth/email-codes/send`   | ar-auth | Send verification email |
| POST   | `/api/auth/email-codes/verify` | ar-auth | Verify email code       |

### DID Authentication

| Method | Endpoint                            | Worker  | Description                  |
| ------ | ----------------------------------- | ------- | ---------------------------- |
| POST   | `/api/auth/dids/challenge`          | ar-auth | DID authentication challenge |
| POST   | `/api/auth/dids/verify`             | ar-auth | DID authentication verify    |
| POST   | `/api/auth/dids/register/challenge` | ar-auth | DID registration challenge   |
| POST   | `/api/auth/dids/register/verify`    | ar-auth | DID registration verify      |
| GET    | `/api/auth/dids`                    | ar-auth | List user's DIDs             |
| DELETE | `/api/auth/dids/:did`               | ar-auth | Unlink DID                   |

### Consent

| Method | Endpoint             | Worker  | Description                                    |
| ------ | -------------------- | ------- | ---------------------------------------------- |
| GET    | `/api/auth/consents` | ar-auth | Retrieve consent screen data for authorization |
| POST   | `/api/auth/consents` | ar-auth | Submit user consent decision (allow/deny)      |

---

## Session Management

| Method | Endpoint                | Worker  | Description                              |
| ------ | ----------------------- | ------- | ---------------------------------------- |
| POST   | `/api/sessions`         | ar-auth | Issue session token for cross-domain SSO |
| POST   | `/api/sessions/verify`  | ar-auth | Verify session token validity            |
| GET    | `/api/sessions/status`  | ar-auth | Check current session status             |
| POST   | `/api/sessions/refresh` | ar-auth | Refresh and extend session expiration    |

---

## Logout

| Method | Endpoint              | Worker  | Description                    |
| ------ | --------------------- | ------- | ------------------------------ |
| GET    | `/logout`             | ar-auth | Front-channel logout endpoint  |
| POST   | `/logout/backchannel` | ar-auth | Back-channel logout (RFC 8725) |

---

## External IdP (ar-bridge)

| Method   | Endpoint                                     | Description              |
| -------- | -------------------------------------------- | ------------------------ |
| GET      | `/api/external/providers`                    | List available providers |
| GET      | `/api/external/:provider/start`              | Start external login     |
| GET/POST | `/api/external/:provider/callback`           | OAuth callback           |
| POST     | `/api/external/:provider/backchannel-logout` | Backchannel logout       |
| GET      | `/api/external/links`                        | List linked identities   |
| POST     | `/api/external/links`                        | Start identity linking   |
| DELETE   | `/api/external/links/:id`                    | Unlink identity          |

### Admin - External Providers

| Method | Endpoint                            | Description          |
| ------ | ----------------------------------- | -------------------- |
| GET    | `/api/admin/external-providers`     | List providers       |
| POST   | `/api/admin/external-providers`     | Create provider      |
| GET    | `/api/admin/external-providers/:id` | Get provider details |
| PUT    | `/api/admin/external-providers/:id` | Update provider      |
| DELETE | `/api/admin/external-providers/:id` | Delete provider      |

---

## Admin API (ar-management)

### Users

| Method | Endpoint                         | Description                               |
| ------ | -------------------------------- | ----------------------------------------- |
| GET    | `/api/admin/users`               | List all users with pagination and search |
| GET    | `/api/admin/users/:id`           | Get specific user details by ID           |
| POST   | `/api/admin/users`               | Create new user account                   |
| PUT    | `/api/admin/users/:id`           | Update existing user information          |
| DELETE | `/api/admin/users/:id`           | Delete user account                       |
| POST   | `/api/admin/users/:id/avatar`    | Upload user avatar image                  |
| DELETE | `/api/admin/users/:id/avatar`    | Delete user avatar image                  |
| DELETE | `/api/admin/users/:id/sessions`  | Revoke all sessions for specific user     |
| POST   | `/api/admin/users/:id/retry-pii` | Retry failed PII creation for user        |
| DELETE | `/api/admin/users/:id/pii`       | Delete user PII data (GDPR Art.17)        |

### Clients

| Method | Endpoint                  | Description                       |
| ------ | ------------------------- | --------------------------------- |
| GET    | `/api/admin/clients`      | List all registered OAuth clients |
| POST   | `/api/admin/clients`      | Create new OAuth client           |
| GET    | `/api/admin/clients/:id`  | Get specific client details by ID |
| PUT    | `/api/admin/clients/:id`  | Update client                     |
| DELETE | `/api/admin/clients/:id`  | Delete client                     |
| DELETE | `/api/admin/clients/bulk` | Bulk delete clients               |

### Sessions

| Method | Endpoint                  | Description                             |
| ------ | ------------------------- | --------------------------------------- |
| GET    | `/api/admin/sessions`     | List all active sessions with filtering |
| GET    | `/api/admin/sessions/:id` | Get specific session details by ID      |
| DELETE | `/api/admin/sessions/:id` | Revoke specific session                 |

### Audit Logs

| Method | Endpoint                    | Description           |
| ------ | --------------------------- | --------------------- |
| GET    | `/api/admin/audit-logs`     | List audit logs       |
| GET    | `/api/admin/audit-logs/:id` | Get audit log details |

### Statistics

| Method | Endpoint           | Description                               |
| ------ | ------------------ | ----------------------------------------- |
| GET    | `/api/admin/stats` | Get system statistics and recent activity |

### Avatars

| Method | Endpoint                 | Description              |
| ------ | ------------------------ | ------------------------ |
| GET    | `/api/avatars/:filename` | Serve user avatar images |

### RBAC - Organizations

| Method | Endpoint                                          | Description                            |
| ------ | ------------------------------------------------- | -------------------------------------- |
| GET    | `/api/admin/organizations`                        | List all organizations with pagination |
| POST   | `/api/admin/organizations`                        | Create new organization                |
| GET    | `/api/admin/organizations/:id`                    | Get specific organization details      |
| PUT    | `/api/admin/organizations/:id`                    | Update organization information        |
| DELETE | `/api/admin/organizations/:id`                    | Delete organization                    |
| GET    | `/api/admin/organizations/:id/members`            | List organization members              |
| POST   | `/api/admin/organizations/:id/members`            | Add member to organization             |
| DELETE | `/api/admin/organizations/:id/members/:subjectId` | Remove member from organization        |

### RBAC - Roles

| Method | Endpoint               | Description               |
| ------ | ---------------------- | ------------------------- |
| GET    | `/api/admin/roles`     | List all available roles  |
| GET    | `/api/admin/roles/:id` | Get specific role details |

### RBAC - User Roles

| Method | Endpoint                                   | Description                      |
| ------ | ------------------------------------------ | -------------------------------- |
| GET    | `/api/admin/users/:id/roles`               | List user's role assignments     |
| POST   | `/api/admin/users/:id/roles`               | Assign role to user              |
| DELETE | `/api/admin/users/:id/roles/:assignmentId` | Remove role assignment from user |

### RBAC - Relationships

| Method | Endpoint                             | Description                                 |
| ------ | ------------------------------------ | ------------------------------------------- |
| GET    | `/api/admin/users/:id/relationships` | List user's relationships (parent/guardian) |
| POST   | `/api/admin/users/:id/relationships` | Create relationship between users           |

### ⭐ Settings API v2 (Recommended)

Unified settings management with category-based endpoints and optimistic locking.

**Configuration Priority**: `env > KV > default` (environment has highest priority)

#### Tenant Settings

| Method | Endpoint                                           | Description                     |
| ------ | -------------------------------------------------- | ------------------------------- |
| GET    | `/api/admin/tenants/:tenantId/settings/:category`  | Get tenant settings by category |
| PATCH  | `/api/admin/tenants/:tenantId/settings/:category`  | Update tenant settings (ifMatch required) |

**Categories**: `oauth`, `session`, `security`, `consent`, `ciba`, `rate-limit`, `credentials`, `federation`, `scim`, `device-flow`, `tokens`, `external-idp`

#### Client Settings

| Method | Endpoint                              | Description           |
| ------ | ------------------------------------- | --------------------- |
| GET    | `/api/admin/clients/:clientId/settings` | Get client settings   |
| PATCH  | `/api/admin/clients/:clientId/settings` | Update client settings (ifMatch required) |

#### Platform Settings (Read-Only)

| Method | Endpoint                                   | Description              |
| ------ | ------------------------------------------ | ------------------------ |
| GET    | `/api/admin/platform/settings/:category`   | Get platform settings    |

**Categories**: `infrastructure`, `encryption`

#### Meta API

| Method | Endpoint                           | Description              |
| ------ | ---------------------------------- | ------------------------ |
| GET    | `/api/admin/settings/meta`         | List all categories      |
| GET    | `/api/admin/settings/meta/:category` | Get category metadata    |

#### Migration API

| Method | Endpoint                             | Description              |
| ------ | ------------------------------------ | ------------------------ |
| POST   | `/api/admin/settings/migrate`        | Execute migration (v1→v2) |
| GET    | `/api/admin/settings/migrate/status` | Get migration status     |
| DELETE | `/api/admin/settings/migrate/lock`   | Clear migration lock     |

---

### ⭐ Policy API (Contract Hierarchy)

Three-layer contract hierarchy management for policy-based access control.

**Hierarchy**: `Tenant Policy → Client Profile → Effective Policy`

#### Tenant Policy

| Method | Endpoint                            | Description                        |
| ------ | ----------------------------------- | ---------------------------------- |
| GET    | `/api/admin/tenant-policy`          | Get current tenant policy          |
| PUT    | `/api/admin/tenant-policy`          | Update tenant policy (ifMatch)     |
| GET    | `/api/admin/tenant-policy/presets`  | List available presets             |
| POST   | `/api/admin/tenant-policy/apply-preset` | Apply preset to tenant         |
| GET    | `/api/admin/tenant-policy/validate` | Validate tenant policy             |

**Presets**: `startup-minimal`, `b2c-standard`, `b2b-standard`, `b2b-enterprise`, `regulated-finance`, `regulated-healthcare`, `high-security`, `custom`

#### Client Profile

| Method | Endpoint                                  | Description                        |
| ------ | ----------------------------------------- | ---------------------------------- |
| GET    | `/api/admin/clients/:clientId/profile`    | Get client profile                 |
| PUT    | `/api/admin/clients/:clientId/profile`    | Update client profile (ifMatch)    |
| GET    | `/api/admin/client-profile-presets`       | List available presets             |
| POST   | `/api/admin/clients/:clientId/apply-preset` | Apply preset to client           |
| GET    | `/api/admin/clients/:clientId/profile/validate` | Validate against tenant policy |

**Presets**: `spa-public`, `mobile-native`, `server-confidential`, `first-party-web`, `first-party-mobile`, `m2m-service`, `iot-device`, `custom`

#### Effective Policy

| Method | Endpoint                              | Description                                |
| ------ | ------------------------------------- | ------------------------------------------ |
| GET    | `/api/admin/effective-policy`         | Get resolved policy (requires `client_id`) |
| GET    | `/api/admin/effective-policy/options` | Get flow designer options (requires `client_id`) |

**Example**: `GET /api/admin/effective-policy?client_id=abc123&debug=true`

---

### Legacy Settings API (Deprecated)

> ⚠️ **Deprecated**: The following endpoints are deprecated in favor of Settings API v2 above.
> Use `/api/admin/tenants/:tenantId/settings/:category` instead.

<details>
<summary>Click to expand legacy endpoints</summary>

#### Settings - Dynamic Configuration

| Method | Endpoint                                             | Description                                     |
| ------ | ---------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/admin/settings`                                | Get all system settings                         |
| PUT    | `/api/admin/settings`                                | Update system settings                          |
| GET    | `/api/admin/settings/code-shards`                    | Get authorization code shard configuration      |
| PUT    | `/api/admin/settings/code-shards`                    | Update authorization code shard count           |
| GET    | `/api/admin/settings/oauth-config`                   | Get OAuth/OIDC configuration                    |
| PUT    | `/api/admin/settings/oauth-config/:name`             | Update specific OAuth config value              |
| DELETE | `/api/admin/settings/oauth-config/:name`             | Reset specific OAuth config to default          |
| DELETE | `/api/admin/settings/oauth-config`                   | Reset all OAuth config overrides to defaults    |
| GET    | `/api/admin/settings/rate-limits`                    | Get all rate limit profiles configuration       |
| GET    | `/api/admin/settings/rate-limits/:profile`           | Get specific rate limit profile                 |
| PUT    | `/api/admin/settings/rate-limits/:profile`           | Update rate limit profile settings              |
| DELETE | `/api/admin/settings/rate-limits/:profile`           | Reset rate limit profile to default             |
| GET    | `/api/admin/settings/refresh-token-sharding`         | Get refresh token sharding configuration        |
| PUT    | `/api/admin/settings/refresh-token-sharding`         | Update refresh token sharding settings          |
| GET    | `/api/admin/settings/refresh-token-sharding/stats`   | Get refresh token shard distribution statistics |
| DELETE | `/api/admin/settings/refresh-token-sharding/cleanup` | Cleanup old generation shards                   |
| GET    | `/api/admin/settings/pii-partitions`                 | Get PII partition configuration                 |
| PUT    | `/api/admin/settings/pii-partitions`                 | Update PII partition settings                   |
| POST   | `/api/admin/settings/pii-partitions/test`            | Test partition routing for given attributes     |
| GET    | `/api/admin/settings/pii-partitions/stats`           | Get PII partition distribution statistics       |
| GET    | `/api/admin/settings/region-shards`                  | Get region sharding configuration               |
| PUT    | `/api/admin/settings/region-shards`                  | Update region sharding settings                 |
| DELETE | `/api/admin/settings/region-shards`                  | Reset region shards to defaults                 |
| POST   | `/api/admin/settings/region-shards/migrate`          | Create new generation (rolling migration)       |
| GET    | `/api/admin/settings/region-shards/validate`         | Validate current configuration                  |

#### Settings - JIT Provisioning

| Method | Endpoint                               | Description                        |
| ------ | -------------------------------------- | ---------------------------------- |
| GET    | `/api/admin/settings/jit-provisioning` | Get JIT provisioning configuration |
| PUT    | `/api/admin/settings/jit-provisioning` | Update JIT provisioning settings   |
| DELETE | `/api/admin/settings/jit-provisioning` | Reset JIT provisioning to defaults |

#### Settings - Domain Hash Keys (Key Rotation)

| Method | Endpoint                                        | Description                                 |
| ------ | ----------------------------------------------- | ------------------------------------------- |
| GET    | `/api/admin/settings/domain-hash-keys`          | Get domain hash key config (secrets masked) |
| POST   | `/api/admin/settings/domain-hash-keys/rotate`   | Start key rotation (add new secret version) |
| PUT    | `/api/admin/settings/domain-hash-keys/complete` | Complete key rotation (deprecate old keys)  |
| GET    | `/api/admin/settings/domain-hash-keys/status`   | Get key rotation migration status           |
| DELETE | `/api/admin/settings/domain-hash-keys/:version` | Delete deprecated secret version            |

</details>

### Role Assignment Rules

| Method | Endpoint                                    | Description                        |
| ------ | ------------------------------------------- | ---------------------------------- |
| POST   | `/api/admin/role-assignment-rules`          | Create new role assignment rule    |
| GET    | `/api/admin/role-assignment-rules`          | List all role assignment rules     |
| GET    | `/api/admin/role-assignment-rules/:id`      | Get specific rule details          |
| PUT    | `/api/admin/role-assignment-rules/:id`      | Update role assignment rule        |
| DELETE | `/api/admin/role-assignment-rules/:id`      | Delete role assignment rule        |
| POST   | `/api/admin/role-assignment-rules/:id/test` | Test rule against sample context   |
| POST   | `/api/admin/role-assignment-rules/evaluate` | Evaluate all rules against context |

### Organization Domain Mappings

| Method | Endpoint                                           | Description                           |
| ------ | -------------------------------------------------- | ------------------------------------- |
| POST   | `/api/admin/org-domain-mappings`                   | Create new domain-to-org mapping      |
| GET    | `/api/admin/org-domain-mappings`                   | List all domain mappings              |
| GET    | `/api/admin/org-domain-mappings/:id`               | Get specific mapping details          |
| PUT    | `/api/admin/org-domain-mappings/:id`               | Update domain mapping                 |
| DELETE | `/api/admin/org-domain-mappings/:id`               | Delete domain mapping                 |
| GET    | `/api/admin/organizations/:org_id/domain-mappings` | List domain mappings for organization |
| POST   | `/api/admin/org-domain-mappings/verify`            | Verify domain ownership               |

### Tombstones (GDPR Deletion Tracking)

| Method | Endpoint                        | Description                            |
| ------ | ------------------------------- | -------------------------------------- |
| GET    | `/api/admin/tombstones`         | List tombstone records with pagination |
| GET    | `/api/admin/tombstones/:id`     | Get specific tombstone details         |
| GET    | `/api/admin/tombstones/stats`   | Get tombstone statistics               |
| POST   | `/api/admin/tombstones/cleanup` | Cleanup expired tombstone records      |
| DELETE | `/api/admin/tombstones/:id`     | Delete tombstone                       |

### Signing Keys

| Method | Endpoint                                   | Description            |
| ------ | ------------------------------------------ | ---------------------- |
| GET    | `/api/admin/signing-keys/status`           | Get signing key status |
| POST   | `/api/admin/signing-keys/rotate`           | Rotate signing keys    |
| POST   | `/api/admin/signing-keys/emergency-rotate` | Emergency key rotation |

---

## Policy Service (ar-policy)

Internal service for policy evaluation (service-to-service communication).

| Method | Endpoint                   | Description                                  |
| ------ | -------------------------- | -------------------------------------------- |
| POST   | `/api/policy/evaluate`     | Evaluate policy for a given context          |
| POST   | `/api/policy/check-role`   | Quick role check for subject                 |
| POST   | `/api/policy/check-access` | Check access for resource/action combination |
| POST   | `/api/policy/is-admin`     | Check if subject has admin privileges        |
| GET    | `/api/policy/health`       | Policy service health check                  |
| GET    | `/api/policy/flags`        | Get all feature flags                        |
| PUT    | `/api/policy/flags/:name`  | Set feature flag                             |
| DELETE | `/api/policy/flags/:name`  | Clear feature flag override                  |

### ReBAC (Zanzibar-style)

| Method | Endpoint                  | Description               |
| ------ | ------------------------- | ------------------------- |
| GET    | `/api/rebac/health`       | ReBAC health check        |
| POST   | `/api/rebac/check`        | Single relationship check |
| POST   | `/api/rebac/batch-check`  | Batch relationship check  |
| POST   | `/api/rebac/list-objects` | List accessible objects   |
| POST   | `/api/rebac/list-users`   | List users with access    |
| POST   | `/api/rebac/write`        | Create relationship tuple |
| DELETE | `/api/rebac/tuples`       | Delete relationship tuple |
| POST   | `/api/rebac/invalidate`   | Invalidate ReBAC cache    |

### Check API

| Method | Endpoint                     | Description             |
| ------ | ---------------------------- | ----------------------- |
| POST   | `/api/check`                 | Permission check        |
| POST   | `/api/check/batch`           | Batch permission check  |
| GET    | `/api/check/subscribe`       | Subscribe to changes    |
| GET    | `/api/check/subscribe/stats` | Subscription statistics |

---

## SAML 2.0 (ar-saml)

### IdP Endpoints

| Method    | Endpoint             | Description            |
| --------- | -------------------- | ---------------------- |
| GET       | `/saml/idp/metadata` | IdP metadata document  |
| GET, POST | `/saml/idp/sso`      | Single Sign-On service |
| GET       | `/saml/idp/init`     | IdP-initiated SSO      |
| GET, POST | `/saml/idp/slo`      | Single Logout service  |

### SP Endpoints

| Method    | Endpoint            | Description                |
| --------- | ------------------- | -------------------------- |
| GET       | `/saml/sp/metadata` | SP metadata document       |
| POST      | `/saml/sp/acs`      | Assertion Consumer Service |
| GET, POST | `/saml/sp/slo`      | Single Logout service      |
| GET       | `/saml/sp/login`    | SP-initiated SSO start     |

### Admin (SAML Providers)

| Method | Endpoint                                        | Description           |
| ------ | ----------------------------------------------- | --------------------- |
| GET    | `/api/admin/saml-providers`                     | List SAML providers   |
| POST   | `/api/admin/saml-providers`                     | Register new provider |
| GET    | `/api/admin/saml-providers/:id`                 | Get provider details  |
| PUT    | `/api/admin/saml-providers/:id`                 | Update provider       |
| DELETE | `/api/admin/saml-providers/:id`                 | Delete provider       |
| POST   | `/api/admin/saml-providers/:id/import-metadata` | Import metadata       |

---

## VC/DID (ar-vc)

### Verifiable Credentials Issuer (OID4VCI)

| Method | Endpoint                                | Description         |
| ------ | --------------------------------------- | ------------------- |
| GET    | `/.well-known/openid-credential-issuer` | Issuer metadata     |
| POST   | `/vci/token`                            | Credential token    |
| GET    | `/vci/offers/:id`                       | Credential offer    |
| POST   | `/vci/credential`                       | Issue credential    |
| POST   | `/vci/deferred`                         | Deferred credential |
| GET    | `/vci/status-lists/:listId`             | Status list         |
| GET    | `/vci/status-lists/:listId/json`        | Status list JSON    |

### Verifiable Presentations (OID4VP)

| Method | Endpoint                                  | Description       |
| ------ | ----------------------------------------- | ----------------- |
| GET    | `/.well-known/openid-credential-verifier` | Verifier metadata |
| POST   | `/vp/authorize`                           | VP authorization  |
| POST   | `/vp/response`                            | VP response       |
| GET    | `/vp/requests/:id`                        | VP request status |

### DID

| Method | Endpoint                | Description    |
| ------ | ----------------------- | -------------- |
| GET    | `/.well-known/did.json` | DID document   |
| GET    | `/did/resolve/:did`     | DID resolution |

---

## SCIM 2.0 (ar-management)

| Method | Endpoint              | Description        |
| ------ | --------------------- | ------------------ |
| GET    | `/scim/v2/Users`      | List/search users  |
| POST   | `/scim/v2/Users`      | Create user        |
| GET    | `/scim/v2/Users/:id`  | Get user           |
| PUT    | `/scim/v2/Users/:id`  | Replace user       |
| PATCH  | `/scim/v2/Users/:id`  | Update user        |
| DELETE | `/scim/v2/Users/:id`  | Delete user        |
| GET    | `/scim/v2/Groups`     | List/search groups |
| POST   | `/scim/v2/Groups`     | Create group       |
| GET    | `/scim/v2/Groups/:id` | Get group          |
| PUT    | `/scim/v2/Groups/:id` | Replace group      |
| PATCH  | `/scim/v2/Groups/:id` | Update group       |
| DELETE | `/scim/v2/Groups/:id` | Delete group       |

---

## Health Check

| Method | Endpoint             | Worker        | Description       |
| ------ | -------------------- | ------------- | ----------------- |
| GET    | `/api/health`        | ar-router     | Router health     |
| GET    | `/api/auth/health`   | ar-auth       | Auth health       |
| GET    | `/api/health`        | ar-token      | Token health      |
| GET    | `/api/health`        | ar-userinfo   | Userinfo health   |
| GET    | `/api/health`        | ar-discovery  | Discovery health  |
| GET    | `/api/health`        | ar-management | Management health |
| GET    | `/api/health`        | ar-bridge     | Bridge health     |
| GET    | `/api/health`        | ar-vc         | VC health         |
| GET    | `/api/policy/health` | ar-policy     | Policy health     |
| GET    | `/saml/health`       | ar-saml       | SAML health       |

---

## Notes

### Authentication Requirements

- **Public Endpoints**: Discovery, Authorization, Token, Health Check
- **User Authentication**: UserInfo, Consent, Session Management, Logout
- **Admin Authentication**: All `/api/admin/*` endpoints require admin privileges
- **RBAC Admin**: Organization, Role, and Relationship management endpoints require system_admin or distributor_admin role
- **PII Admin**: PII partition settings, tombstone management, and user PII deletion require system_admin role
- **Client Authentication**: Token, Introspect, Revoke endpoints
- **Service-to-Service**: Policy Service endpoints require POLICY_API_SECRET bearer token

### Rate Limiting

All endpoints are protected by rate limiting. See [API Documentation](./README.md#rate-limiting) for details.

---

## References

- **OpenID Connect Core 1.0**: https://openid.net/specs/openid-connect-core-1_0.html
- **OAuth 2.0 (RFC 6749)**: https://tools.ietf.org/html/rfc6749
- **RFC 7591**: Dynamic Client Registration Protocol
- **RFC 7662**: OAuth 2.0 Token Introspection
- **RFC 7009**: OAuth 2.0 Token Revocation
- **RFC 9126**: OAuth 2.0 Pushed Authorization Requests
- **RFC 8628**: OAuth 2.0 Device Authorization Grant
- **RFC 8725**: JSON Web Token Best Current Practices
- **WebAuthn Level 2**: https://www.w3.org/TR/webauthn-2/
- **SAML 2.0 Core**: https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf
- **OID4VCI**: https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html
- **OID4VP**: https://openid.net/specs/openid-4-verifiable-presentations-1_0.html
