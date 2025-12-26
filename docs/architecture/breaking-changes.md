# Authrim Breaking Changes Checklist

> **Purpose**: This document lists items that would have breaking impacts if changed in Authrim's design decisions.
> Reference this when developing new features or refactoring to maintain compatibility.

---

## 1. API Naming & URL Structure

**Impact**: All clients and SDKs would have breaking changes

### OIDC Core Endpoints (Cannot be changed)

| Method     | Endpoint                            | Specification            |
| ---------- | ----------------------------------- | ------------------------ |
| `GET`      | `/.well-known/openid-configuration` | OIDC Discovery 1.0       |
| `GET`      | `/.well-known/jwks.json`            | RFC 7517                 |
| `GET/POST` | `/authorize`                        | OIDC Core 3.1.2          |
| `POST`     | `/token`                            | OIDC Core 3.1.3          |
| `GET/POST` | `/userinfo`                         | OIDC Core 5.3            |
| `GET`      | `/logout`                           | OIDC RP-Initiated Logout |
| `POST`     | `/logout/backchannel`               | OIDC Back-Channel Logout |
| `POST`     | `/introspect`                       | RFC 7662                 |
| `POST`     | `/revoke`                           | RFC 7009                 |
| `POST`     | `/register`                         | RFC 7591 (DCR)           |

### OAuth 2.0 Extension Endpoints

| Method     | Endpoint                | Specification  |
| ---------- | ----------------------- | -------------- |
| `POST`     | `/as/par`               | RFC 9126 (PAR) |
| `POST`     | `/device_authorization` | RFC 8628       |
| `GET/POST` | `/device`               | RFC 8628       |
| `POST`     | `/bc-authorize`         | OIDC CIBA      |

### Session Management

| Method     | Endpoint             | Specification               |
| ---------- | -------------------- | --------------------------- |
| `GET/POST` | `/session/check`     | OIDC Session Management 1.0 |
| `GET/POST` | `/authorize/confirm` | Re-authentication           |
| `GET/POST` | `/authorize/login`   | Session-less Auth           |

### Authentication API (Internal)

| Method     | Endpoint                             | Purpose                    |
| ---------- | ------------------------------------ | -------------------------- |
| `POST`     | `/api/auth/passkey/register/options` | WebAuthn registration options |
| `POST`     | `/api/auth/passkey/register/verify`  | WebAuthn registration verify |
| `POST`     | `/api/auth/passkey/login/options`    | WebAuthn login options     |
| `POST`     | `/api/auth/passkey/login/verify`     | WebAuthn login verify      |
| `POST`     | `/api/auth/email-code/send`          | Email OTP send             |
| `POST`     | `/api/auth/email-code/verify`        | Email OTP verify           |
| `GET/POST` | `/api/auth/consent`                  | OAuth consent screen       |

### Admin API

| Method                | Endpoint                  | Purpose             |
| --------------------- | ------------------------- | ------------------- |
| `GET/POST/PUT/DELETE` | `/api/admin/users/*`      | User management     |
| `GET/POST/PUT/DELETE` | `/api/admin/clients/*`    | Client management   |
| `GET/DELETE`          | `/api/admin/sessions/*`   | Session management  |
| `GET`                 | `/api/admin/audit-log/*`  | Audit log           |
| `GET/PUT`             | `/api/admin/settings/*`   | Settings management |
| `GET/POST`            | `/api/admin/signing-keys/*` | Signing key management |
| `ALL`                 | `/scim/v2/*`              | SCIM 2.0 (RFC 7643/7644) |

---

## 2. ID Format

**Impact**: Full data re-issuance level

### Current ID Format List

| ID Type                       | Format                              | Example                                | Generation Logic                          |
| ----------------------------- | ----------------------------------- | -------------------------------------- | ----------------------------------------- |
| **User ID**                   | UUID v4                             | `550e8400-e29b-41d4-a716-446655440000` | `crypto.randomUUID()`                     |
| **Client ID**                 | Long unique identifier (~135 chars) or custom | `b42bdc5e-7183-46ef-859c-fd21d4589cd6` | `generateSecureRandomString()` + Base64URL |
| **Session ID**                | `{shardIndex}_session_{uuid}`       | `7_session_550e8400-...`               | FNV-1a hash → shard routing               |
| **Authorization Code**        | `{shardIndex}_{randomCode}`         | `23_eyJhbGciOi...`                     | FNV-1a(userId:clientId) % shardCount      |
| **Refresh Token JTI**         | `v{gen}_{shard}_{randomPart}`       | `v1_7_rt_550e8400-...`                 | SHA-256(userId:clientId) % shardCount     |
| **Refresh Token JTI (Legacy)** | `rt_{uuid}`                        | `rt_550e8400-...`                      | generation=0 treatment                    |

### Subject (sub) Claim

| Type         | Format            | Description                      |
| ------------ | ----------------- | -------------------------------- |
| **public**   | User ID (UUID)    | Same across all clients          |
| **pairwise** | Hash value        | `hash(userId + clientId + salt)` |

### Related Files

- `packages/shared/src/utils/id.ts` - ID generation
- `packages/shared/src/utils/session-helper.ts` - Session ID
- `packages/shared/src/utils/tenant-context.ts` - Authorization code sharding
- `packages/shared/src/utils/refresh-token-sharding.ts` - RT sharding
- `packages/shared/src/utils/pairwise.ts` - Pairwise Subject

---

## 3. Session Model

**Impact**: Complete authentication rebuild

### Session Structure

```typescript
interface Session {
  id: string; // "{shardIndex}_session_{uuid}"
  userId: string; // User ID (UUID)
  expiresAt: number; // Expiration (milliseconds timestamp)
  createdAt: number; // Creation time (milliseconds timestamp)
  data?: SessionData; // Additional metadata
}

interface SessionData {
  amr?: string[]; // Authentication Methods References
  acr?: string; // Authentication Context Class Reference
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  [key: string]: unknown;
}
```

### Storage Architecture (3 Layers)

| Layer                      | Purpose               | Access Speed       |
| -------------------------- | --------------------- | ------------------ |
| **Memory Cache** (Hot)     | SessionStore DO Map   | Sub-millisecond    |
| **Durable Storage** (Warm) | SessionStore DO persistent | O(1)          |
| **D1 Database** (Cold)     | Backup & Audit        | 100ms timeout      |

### Sharding Configuration

| Item                    | Value                                  |
| ----------------------- | -------------------------------------- |
| Default shard count     | 32                                     |
| DO name pattern         | `tenant:default:session:shard-{index}` |
| Config key              | `AUTHRIM_SESSION_SHARDS` (KV/env var)  |
| Cleanup interval        | 5 minutes                              |

### Related Files

- `packages/shared/src/durable-objects/SessionStore.ts`

---

## 4. Refresh Token Model

**Impact**: All users forced re-login

### Token Structure (JWT)

```typescript
interface RefreshTokenClaims {
  iss: string; // Issuer
  sub: string; // Subject (User ID)
  aud: string; // Audience (Client ID)
  exp: number; // Expiration Time
  iat: number; // Issued At
  jti: string; // JWT ID (unique identifier)
  rtv: number; // Refresh Token Version (rotation generation)
}
```

### Token Family Structure

```typescript
interface TokenFamilyV2 {
  version: number; // Rotation generation (monotonically increasing)
  last_jti: string; // Last issued JWT ID
  last_used_at: number; // Last used time (milliseconds)
  expires_at: number; // Absolute expiration (milliseconds)
  user_id: string; // User ID
  client_id: string; // Client ID
  allowed_scope: string; // Initial scope (prevent escalation)
}
```

### Rotation Strategy (Version-Based Theft Detection)

| Event                                             | Action                          |
| ------------------------------------------------- | ------------------------------- |
| `incomingVersion < currentVersion`                | **Theft detected** → Invalidate entire family |
| `incomingVersion == currentVersion` and `jti matches` | Issue new version           |
| `jti mismatch`                                    | **Tampering detected** → Invalidate entire family |
| Scope escalation request                          | **Reject** (invalid_scope)      |

### Sharding

| Item                    | Value                                                            |
| ----------------------- | ---------------------------------------------------------------- |
| Default shard count     | 8                                                                |
| JTI format (new)        | `v{generation}_{shardIndex}_{randomPart}`                        |
| JTI format (legacy)     | `rt_{uuid}` (generation=0)                                       |
| DO name pattern         | `tenant:default:refresh-rotator:{clientId}:v{gen}:shard-{index}` |

### Related Files

- `packages/shared/src/durable-objects/RefreshTokenRotator.ts`
- `packages/shared/src/utils/refresh-token-sharding.ts`
- `packages/shared/src/utils/jwt.ts`

---

## 5. OIDC Claim Structure

**Impact**: All RPs would break

### ID Token Claims

#### Required Claims (OIDC Core)

| Claim | Type   | Description              |
| ----- | ------ | ------------------------ |
| `iss` | string | Issuer URL               |
| `sub` | string | Subject (User identifier) |
| `aud` | string | Audience (client_id)     |
| `exp` | number | Expiration (UNIX seconds) |
| `iat` | number | Issued at (UNIX seconds) |

#### Authentication Context Claims

| Claim       | Type     | Description                            |
| ----------- | -------- | -------------------------------------- |
| `auth_time` | number   | Authentication execution time          |
| `nonce`     | string   | Replay attack prevention               |
| `acr`       | string   | Authentication Context Class Reference |
| `amr`       | string[] | Authentication Methods References      |
| `azp`       | string   | Authorized Party                       |

#### Token Hashes

| Claim     | Purpose                       |
| --------- | ----------------------------- |
| `at_hash` | Access Token Hash (code flow) |
| `c_hash`  | Code Hash (hybrid flow)       |

#### Session Management

| Claim | Purpose                            |
| ----- | ---------------------------------- |
| `sid` | Session ID (for RP-Initiated Logout) |

#### RBAC Claims (Authrim Extension)

| Claim               | Type     | Description       |
| ------------------- | -------- | ----------------- |
| `authrim_roles`     | string[] | Effective roles   |
| `authrim_user_type` | string   | User type         |
| `authrim_org_id`    | string   | Primary org ID    |
| `authrim_plan`      | string   | Organization plan |
| `authrim_org_type`  | string   | Organization type |

### Scope-Based Claims (UserInfo)

| Scope     | Claims                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile` | name, family_name, given_name, middle_name, nickname, preferred_username, profile, picture, website, gender, birthdate, zoneinfo, locale, updated_at |
| `email`   | email, email_verified                                                                                                                                |
| `phone`   | phone_number, phone_number_verified                                                                                                                  |
| `address` | address (nested object)                                                                                                                              |

### Access Token Claims

| Claim                 | Type     | Description                  |
| --------------------- | -------- | ---------------------------- |
| `iss`                 | string   | Issuer                       |
| `sub`                 | string   | Subject                      |
| `aud`                 | string   | Audience (resource server)   |
| `exp`                 | number   | Expiration                   |
| `iat`                 | number   | Issued at                    |
| `jti`                 | string   | JWT ID (for revocation)      |
| `scope`               | string   | Granted scopes               |
| `client_id`           | string   | Client ID                    |
| `cnf`                 | object   | DPoP confirmation (`{ jkt: string }`) |
| `authrim_permissions` | string[] | Phase 2 Policy Embedding     |

### Related Files

- `packages/shared/src/types/oidc.ts`
- `packages/shared/src/utils/jwt.ts`
- `packages/op-token/src/token.ts`
- `packages/op-userinfo/src/userinfo.ts`

---

## 6. Data Model

**Impact**: Migration nightmare

### Core Entities

#### users Table

| Column                              | Type             | Description        |
| ----------------------------------- | ---------------- | ------------------ |
| `id`                                | TEXT PRIMARY KEY | UUID v4            |
| `email`                             | TEXT UNIQUE      | Email address      |
| `email_verified`                    | INTEGER          | Verified flag      |
| `password_hash`                     | TEXT             | Password hash      |
| `name`, `given_name`, `family_name` | TEXT             | OIDC standard claims |
| `nickname`, `profile`, `picture`    | TEXT             | OIDC standard claims |
| `created_at`, `updated_at`          | INTEGER          | UNIX seconds       |

#### oauth_clients Table

| Column                       | Type             | Description         |
| ---------------------------- | ---------------- | ------------------- |
| `client_id`                  | TEXT PRIMARY KEY | Client ID           |
| `client_secret`              | TEXT             | Client secret       |
| `redirect_uris`              | TEXT             | JSON array          |
| `grant_types`                | TEXT             | JSON array          |
| `response_types`             | TEXT             | JSON array          |
| `token_endpoint_auth_method` | TEXT             | Auth method         |
| `subject_type`               | TEXT             | public/pairwise     |

#### sessions Table

| Column       | Type             | Description           |
| ------------ | ---------------- | --------------------- |
| `id`         | TEXT PRIMARY KEY | Session ID            |
| `user_id`    | TEXT             | User ID (FK)          |
| `expires_at` | INTEGER          | Expiration (UNIX seconds) |
| `created_at` | INTEGER          | Creation (UNIX seconds) |

### RBAC Phase 1 Entities

#### organizations Table

| Column          | Type             | Description                          |
| --------------- | ---------------- | ------------------------------------ |
| `id`            | TEXT PRIMARY KEY | Organization ID                      |
| `tenant_id`     | TEXT             | Tenant ID                            |
| `name`          | TEXT             | Organization name                    |
| `org_type`      | TEXT             | distributor/enterprise/department    |
| `parent_org_id` | TEXT             | Parent org ID (hierarchy)            |
| `plan`          | TEXT             | free/starter/professional/enterprise |
| `is_active`     | INTEGER          | Active flag                          |

#### roles Table

| Column             | Type             | Description            |
| ------------------ | ---------------- | ---------------------- |
| `id`               | TEXT PRIMARY KEY | Role ID                |
| `name`             | TEXT             | Role name              |
| `permissions_json` | TEXT             | Permissions JSON array |
| `role_type`        | TEXT             | system/builtin/custom  |
| `hierarchy_level`  | INTEGER          | 0-100 (higher = more privilege) |
| `parent_role_id`   | TEXT             | Parent role ID (inheritance) |

#### role_assignments Table

| Column         | Type             | Description            |
| -------------- | ---------------- | ---------------------- |
| `id`           | TEXT PRIMARY KEY | Assignment ID          |
| `subject_id`   | TEXT             | User ID                |
| `role_id`      | TEXT             | Role ID                |
| `scope_type`   | TEXT             | global/org/resource    |
| `scope_target` | TEXT             | Scope target           |
| `expires_at`   | INTEGER          | Expiration (optional)  |

### Related Files

- `migrations/001_initial_schema.sql` - Initial schema
- `migrations/009-012_rbac_phase1_*.sql` - RBAC Phase 1

---

## 7. /authorize & /token Structure

**Impact**: Cannot be changed per OIDC spec

### /authorize Parameters

#### Required Parameters

| Parameter       | Description                                        |
| --------------- | -------------------------------------------------- |
| `response_type` | `code`, `id_token`, `token`, `code id_token`, etc. |
| `client_id`     | Registered client ID                               |
| `redirect_uri`  | Registered redirect URI                            |
| `scope`         | `openid` required + additional scopes              |

#### Recommended/Optional Parameters

| Parameter               | Description                                   |
| ----------------------- | --------------------------------------------- |
| `state`                 | CSRF protection                               |
| `nonce`                 | ID Token binding                              |
| `code_challenge`        | PKCE (S256)                                   |
| `code_challenge_method` | `S256` only                                   |
| `prompt`                | `login`, `consent`, `select_account`, `none`  |
| `max_age`               | Max authentication age                        |
| `claims`                | Claims request (JSON)                         |
| `response_mode`         | `query`, `fragment`, `form_post`, `query.jwt` |
| `request`               | JAR (RFC 9101)                                |
| `request_uri`           | PAR (RFC 9126)                                |

### /authorize Response

| response_mode  | Format                                     |
| -------------- | ------------------------------------------ |
| `query`        | `?code=...&state=...&iss=...`              |
| `fragment`     | `#access_token=...&id_token=...&state=...` |
| `form_post`    | HTML form auto-submit                      |
| `*.jwt` (JARM) | `?response=eyJ...`                         |

### /token Grant Types

| Grant Type                                     | Specification |
| ---------------------------------------------- | ------------- |
| `authorization_code`                           | RFC 6749 §4.1 |
| `refresh_token`                                | RFC 6749 §6   |
| `urn:ietf:params:oauth:grant-type:jwt-bearer`  | RFC 7523      |
| `urn:ietf:params:oauth:grant-type:device_code` | RFC 8628      |
| `urn:openid:params:grant-type:ciba`            | OIDC CIBA     |

### /token Response

```json
{
  "access_token": "2YotnFZFEjr1zCsicMWpAA",
  "token_type": "Bearer",
  "expires_in": 3600,
  "id_token": "eyJhbGciOiJSUzI1NiIs...",
  "refresh_token": "tGzv3JOkF0XG5Qx2TlKWIQ",
  "scope": "openid profile email",
  "iss": "https://provider.example.com"
}
```

### Client Authentication Methods

| Method                | Description             |
| --------------------- | ----------------------- |
| `client_secret_basic` | HTTP Basic Auth         |
| `client_secret_post`  | Form parameter          |
| `client_secret_jwt`   | JWT Bearer (symmetric)  |
| `private_key_jwt`     | JWT Bearer (asymmetric) |
| `none`                | Public clients          |

### Related Files

- `packages/op-auth/src/authorize.ts`
- `packages/op-token/src/token.ts`

---

## 8. RBAC/ABAC Evaluation Order

**Impact**: Allow/deny results change, causing major issues

### Evaluation Flow

```
1. Authentication check
   └─ Fail → 401 Unauthorized

2. Role membership check
   └─ requireRole(role) → Single role required
   └─ requireAnyRole([roles]) → Any one required (OR)
   └─ requireAllRoles([roles]) → All required (AND)
   └─ requireAdmin() → system_admin|distributor_admin|org_admin|admin
   └─ requireSystemAdmin() → system_admin only

3. Access decision
   └─ Allow → Continue processing
   └─ Deny → 403 Forbidden
```

### Default Role Hierarchy

| Role                | hierarchy_level | Description           |
| ------------------- | --------------- | --------------------- |
| `system_admin`      | 100             | Highest privilege     |
| `distributor_admin` | 50              | Distributor admin     |
| `org_admin`         | 30              | Organization admin    |
| `end_user`          | 0               | General user          |

### RBAC Claim Resolution Order

```
1. Cache check (KV RBAC_CACHE - TTL 5 min)
2. On cache miss:
   a. resolveEffectiveRoles (DB)
   b. resolveOrganizationInfo (DB)
   c. resolveUserType (DB)
   d. resolveScopedRoles (Phase 2)
   e. resolveAllOrganizations (Phase 2)
   f. resolveRelationshipsSummary (Phase 2)
3. Filter by env var RBAC_ID_TOKEN_CLAIMS
4. Save to cache (Fire-and-forget)
```

### Related Files

- `packages/shared/src/middleware/rbac.ts`
- `packages/shared/src/utils/rbac-claims.ts`
- `packages/shared/src/types/rbac.ts`

---

## 9. Audit Log Schema

**Impact**: Cannot read past logs

### Table Structure

```sql
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL
);
```

### Type Definition

```typescript
interface AuditLogEntry {
  id: string;
  tenantId: string;
  userId: string;
  action: string; // e.g., 'signing_keys.rotate.emergency'
  resource: string; // e.g., 'signing_keys'
  resourceId: string;
  ipAddress: string;
  userAgent: string;
  metadata: string; // JSON string
  severity: 'info' | 'warning' | 'critical';
  createdAt: number; // UNIX milliseconds
}
```

### Action Naming Convention

```
{resource}.{action}.{detail}

Examples:
- signing_keys.rotate.emergency
- signing_keys.rotate.normal
- signing_keys.revoke
- user.create
- user.update
- user.delete
- client.create
- session.revoke
```

### Indexes

| Index                      | Columns                    |
| -------------------------- | -------------------------- |
| `idx_audit_log_user_id`    | user_id                    |
| `idx_audit_log_created_at` | created_at                 |
| `idx_audit_log_action`     | action                     |
| `idx_audit_log_resource`   | resource_type, resource_id |

### Related Files

- `migrations/001_initial_schema.sql`
- `packages/shared/src/utils/audit-log.ts`
- `packages/shared/src/types/admin.ts`

---

## 10. Error Code System

**Impact**: SDKs would break

### OAuth 2.0 Standard Errors (RFC 6749)

| Error Code                  | HTTP | Description             |
| --------------------------- | ---- | ----------------------- |
| `invalid_request`           | 400  | Invalid parameters      |
| `invalid_client`            | 401  | Client auth failed      |
| `invalid_grant`             | 400  | Invalid auth grant      |
| `unauthorized_client`       | 400  | Client unauthorized     |
| `unsupported_grant_type`    | 400  | Unsupported grant type  |
| `invalid_scope`             | 400  | Invalid scope           |
| `access_denied`             | 403  | Access denied           |
| `unsupported_response_type` | 400  | Unsupported response type |
| `server_error`              | 500  | Server error            |
| `temporarily_unavailable`   | 503  | Temporarily unavailable |

### OIDC Specific Errors

| Error Code                   | Description               |
| ---------------------------- | ------------------------- |
| `interaction_required`       | User interaction required |
| `login_required`             | Login required            |
| `account_selection_required` | Account selection required |
| `consent_required`           | Consent required          |
| `invalid_request_uri`        | Invalid request_uri       |
| `invalid_request_object`     | Invalid Request Object    |
| `request_not_supported`      | Request not supported     |
| `request_uri_not_supported`  | request_uri not supported |
| `registration_not_supported` | Registration not supported |

### Resource Server Errors

| Error Code           | HTTP | Description   |
| -------------------- | ---- | ------------- |
| `invalid_token`      | 401  | Invalid token |
| `insufficient_scope` | 403  | Insufficient scope |

### Error Response Format

```json
{
  "error": "invalid_request",
  "error_description": "The request is missing a required parameter",
  "error_uri": "https://example.com/errors/invalid_request"
}
```

### RBAC Error Extension

```json
{
  "error": "access_denied",
  "error_description": "Missing required roles: system_admin",
  "required_roles": ["system_admin", "org_admin"],
  "missing_roles": ["system_admin"]
}
```

### Related Files

- `packages/shared/src/constants.ts` - Error code definitions
- `packages/shared/src/utils/errors.ts` - OIDCError class

---

## Impact Matrix for Changes

| Item               | Impact      | Scope                | Migration Difficulty |
| ------------------ | ----------- | -------------------- | -------------------- |
| API URL structure  | 🔴 Critical | All clients/SDKs     | High                 |
| ID format          | 🔴 Critical | Full data re-issue   | Highest              |
| Session model      | 🔴 Critical | Auth foundation      | High                 |
| Refresh Token      | 🔴 Critical | All users re-login   | High                 |
| OIDC claims        | 🔴 Critical | All RPs              | High                 |
| Data model         | 🟠 High     | Migration required   | Medium-High          |
| /authorize /token  | 🔴 Critical | OIDC spec compliance | Cannot change        |
| RBAC eval order    | 🟠 High     | Permission results   | Medium               |
| Audit Log          | 🟡 Medium   | Past log compatibility | Medium             |
| Error codes        | 🟠 High     | SDK/clients          | Medium               |

---

## Pre-Change Checklist

Before making changes, confirm the following:

- [ ] Reviewed relevant items in this document
- [ ] For breaking changes, created a migration plan
- [ ] Listed affected clients/SDKs
- [ ] Considered alternative approaches maintaining backward compatibility
- [ ] Verified OIDC/OAuth 2.0 spec compliance
- [ ] Validated impact scope in test environment
- [ ] Created documentation update plan

---

_Last updated: 2025-12-09_
