# Authrim API Documentation 🚀

**Last Updated**: 2025-11-13
**API Version**: v1.0 (Phase 5)
**Base URL**: `https://your-domain.com`

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [API Categories](#api-categories)
3. [Authentication Methods](#authentication-methods)
4. [Rate Limiting](#rate-limiting)
5. [Error Handling](#error-handling)
6. [OpenAPI Specification](#openapi-specification)
7. [Quick Start](#quick-start)

---

## Overview

Authrim OIDC OP provides 39+ API endpoints:

| Category | Endpoint Count | Status |
|---------|----------------|-----------|
| **OIDC Core** | 7 | ✅ Phase 2 Complete |
| **OIDC Extensions** | 4 | ✅ Phase 4 Complete |
| **Auth UI** | 6 | ✅ Phase 5 Stage 2 Complete |
| **Admin API** | 9 | 🔄 Phase 5 Stage 2 Partial (6/9) |
| **Session Management** | 6 | 📝 Phase 5 Planned |
| **Logout** | 2 | 📝 Phase 5 Planned |
| **Token Exchange** | 2+ | 🔄 Under Consideration |
| **Total** | **39+** | - |

---

## API Categories

### 1. OIDC Core APIs ✅ Implemented

Standard OIDC OP basic functionality:

- `GET /.well-known/openid-configuration` - Discovery
- `GET /.well-known/jwks.json` - JSON Web Key Set
- `GET/POST /authorize` - Authorization Endpoint
- `POST /token` - Token Endpoint
- `GET/POST /userinfo` - UserInfo Endpoint

**Compliance**: OpenID Connect Core 1.0, RFC 6749

### 2. OIDC Extensions ✅ Implemented

Enterprise-grade security features:

- `POST /register` - Dynamic Client Registration (RFC 7591)
- `POST /as/par` - Pushed Authorization Requests (RFC 9126)
- `POST /introspect` - Token Introspection (RFC 7662)
- `POST /revoke` - Token Revocation (RFC 7009)

**Additional Features**:
- DPoP (RFC 9449) - Token Binding
- Pairwise Subject Identifiers - Privacy Protection
- Refresh Token Rotation

### 3. Auth UI APIs ✅ Implemented (Phase 5, Stage 2)

Passwordless authentication endpoints:

#### Passkey Authentication
- `POST /auth/passkey/register/options` - Generate Passkey Registration Options
- `POST /auth/passkey/register/verify` - Verify Passkey Registration
- `POST /auth/passkey/login/options` - Generate Passkey Login Options
- `POST /auth/passkey/login/verify` - Verify Passkey Login

#### Magic Link Authentication
- `POST /auth/magic-link/send` - Send Magic Link Email
- `GET /auth/magic-link/verify` - Verify Magic Link Token

#### OAuth Consent
- `GET /auth/consent` - Get Consent Screen Data
- `POST /auth/consent` - Submit Consent Decision

**Documentation:**
- [Passkey API](./auth/passkey.md)
- [Magic Link API](./auth/magic-link.md)
- [Consent API](./auth/consent.md)

### 4. Admin API 🔄 Partial (Phase 5, Stage 2)

Admin-only APIs for user and client management:

#### User Management ✅ Implemented
- `GET /admin/users` - List/Search Users (pagination, search, filtering)
- `GET /admin/users/:id` - Get User Details
- `POST /admin/users` - Create User
- `PUT /admin/users/:id` - Update User
- `DELETE /admin/users/:id` - Delete User (cascade)

#### Client Management ✅ Implemented (Read-only)
- `GET /admin/clients` - List Clients (pagination, search)
- `GET /admin/clients/:id` - Get Client Details

#### Client Management 📝 Planned (Phase 6)
- `POST /admin/clients` - Create Client
- `PUT /admin/clients/:id` - Update Client
- `POST /admin/clients/:id/regenerate-secret` - Regenerate Client Secret
- `DELETE /admin/clients/:id` - Delete Client

#### Statistics ✅ Implemented
- `GET /admin/stats` - System Statistics & Recent Activity

**Documentation:**
- [Admin User Management API](./admin/users.md)
- [Admin Client Management API](./admin/clients.md)
- [Admin Statistics API](./admin/statistics.md)

**Authentication**: Bearer Token (admin privileges required - Phase 6)

### 5. Session Management API 📝 Phase 5

Cross-domain SSO with ITP support:

- `POST /auth/session/token` - Issue Short-lived Token (5min TTL)
- `POST /auth/session/verify` - Verify Short-lived Token
- `GET /session/status` - Check Session Validity
- `POST /session/refresh` - Extend Session
- `GET /admin/sessions` - List Sessions (Admin)
- `POST /admin/sessions/:id/revoke` - Revoke Session (Admin)

**Feature**: No third-party cookies

### 6. Logout API 📝 Phase 5

Standard logout functionality:

- `GET /logout` - Front-channel Logout
- `POST /logout/backchannel` - Back-channel Logout (RFC recommended)

---

## Authentication Methods

### 1. OAuth 2.0 Bearer Token

**Target**: `/userinfo`, `/introspect`, `/revoke`, `/admin/*`

```http
Authorization: Bearer {access_token}
```

### 2. Client Authentication

**Target**: `/token`, `/introspect`, `/revoke`

**Supported Methods**:
- `client_secret_basic` - Basic authentication (default)
- `client_secret_post` - POST parameters
- `client_secret_jwt` - JWT (RFC 7523)
- `private_key_jwt` - Private key JWT

### 3. Cookie + CSRF Token

**Target**: Admin sessions, consent screen

```http
Cookie: session_id={session_id}
X-CSRF-Token: {csrf_token}
```

### 4. DPoP (RFC 9449)

**Target**: All token endpoints (optional)

```http
DPoP: {dpop_proof_jwt}
```

---

## Rate Limiting

| Endpoint | Limit | Period | Unit |
|--------------|------|------|------|
| `/login` | 5 | 1 min | IP |
| `/register` | 3 | 1 min | IP |
| `/auth/magic-link/send` | 3 | 15 min | email |
| `/token` | 10 | 1 min | client_id |
| `/admin/*` | 100 | 1 min | session |
| Others | 60 | 1 min | IP |

**When Rate Limit Exceeded**:
```json
{
  "error": "rate_limit_exceeded",
  "error_description": "Too many requests. Please try again later.",
  "retry_after": 60
}
```

**Headers**:
```http
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 2
X-RateLimit-Reset: 1678901234
```

---

## Error Handling

### Standard Error Response

```json
{
  "error": "invalid_request",
  "error_description": "The request is missing a required parameter",
  "error_uri": "https://docs.authrim.org/errors/invalid_request"
}
```

### Error Code List

#### OAuth 2.0 Standard Errors (RFC 6749)

| Error Code | HTTP Status | Description |
|-------------|-------------|------|
| `invalid_request` | 400 | Invalid request parameters |
| `invalid_client` | 401 | Client authentication failed |
| `invalid_grant` | 400 | Invalid authorization code/refresh token |
| `unauthorized_client` | 400 | Client is not authorized |
| `unsupported_grant_type` | 400 | Grant type is not supported |
| `invalid_scope` | 400 | Invalid scope |
| `access_denied` | 403 | User denied consent |
| `server_error` | 500 | Internal server error |
| `temporarily_unavailable` | 503 | Temporarily unavailable |

#### OIDC Errors

| Error Code | HTTP Status | Description |
|-------------|-------------|------|
| `interaction_required` | 400 | User interaction required |
| `login_required` | 400 | Login required |
| `consent_required` | 400 | Consent required |
| `invalid_request_uri` | 400 | Invalid request_uri |
| `invalid_request_object` | 400 | Invalid request JWT |

#### Authrim Custom Errors

| Error Code | HTTP Status | Description |
|-------------|-------------|------|
| `passkey_not_supported` | 400 | Passkey is not supported |
| `magic_link_expired` | 400 | Magic Link expired |
| `session_expired` | 401 | Session expired |
| `rate_limit_exceeded` | 429 | Rate limit exceeded |
| `insufficient_permissions` | 403 | Insufficient permissions (Admin API) |

---

## OpenAPI Specification

Detailed API specifications are provided in OpenAPI 3.1 format:

📄 **[openapi.yaml](./openapi.yaml)** - Complete API Specification

### Using the Specification

#### View with Swagger UI

```bash
# Start Swagger UI locally
npx swagger-ui-watcher docs/api/openapi.yaml
```

Open `http://localhost:8080` in your browser

#### Code Generation

```bash
# Generate TypeScript SDK
npx openapi-generator-cli generate \
  -i docs/api/openapi.yaml \
  -g typescript-fetch \
  -o ./sdk/typescript

# Generate Python SDK
npx openapi-generator-cli generate \
  -i docs/api/openapi.yaml \
  -g python \
  -o ./sdk/python
```

---

## Quick Start

### 1. Basic OIDC Authentication Flow

```bash
# 1. Discovery
curl https://your-domain.com/.well-known/openid-configuration

# 2. Authorization Request
https://your-domain.com/authorize?
  response_type=code&
  client_id=YOUR_CLIENT_ID&
  redirect_uri=https://yourapp.com/callback&
  scope=openid profile email&
  state=RANDOM_STATE

# 3. Token Request
curl -X POST https://your-domain.com/token \
  -u "CLIENT_ID:CLIENT_SECRET" \
  -d "grant_type=authorization_code" \
  -d "code=AUTHORIZATION_CODE" \
  -d "redirect_uri=https://yourapp.com/callback"

# 4. UserInfo Request
curl https://your-domain.com/userinfo \
  -H "Authorization: Bearer ACCESS_TOKEN"
```

### 2. Passkey Registration Flow

```bash
# 1. Start Passkey Registration
curl -X POST https://your-domain.com/auth/passkey/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "name": "John Doe"
  }'

# 2. Execute WebAuthn API in Browser
# navigator.credentials.create()

# 3. Verify Passkey
curl -X POST https://your-domain.com/auth/passkey/verify \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {...}
  }'
```

### 3. Send Magic Link

```bash
curl -X POST https://your-domain.com/auth/magic-link/send \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com"
  }'
```

### 4. Admin API - Get User List

```bash
curl https://your-domain.com/admin/users?q=john&limit=50 \
  -H "Authorization: Bearer ADMIN_ACCESS_TOKEN"
```

---

## SDKs & Libraries

### Official SDKs (Planned for Phase 6)

- **TypeScript/JavaScript SDK** - npm: `@authrim/sdk`
- **Python SDK** - PyPI: `authrim-sdk`
- **Go SDK** - `github.com/authrim/go-sdk`
- **Rust SDK** - Crates.io: `authrim-sdk`

### Community SDKs

- **Ruby** - `authrim-ruby` (community-maintained)
- **PHP** - `authrim-php` (community-maintained)

---

## API Versioning

### Current Version

- **API Version**: v1.0
- **OpenAPI Version**: 3.1.0
- **OIDC Version**: 1.0
- **OAuth Version**: 2.0, 2.1

### Version Management Policy

- **Major Version Change**: Breaking changes (e.g., v1 → v2)
- **Minor Version Change**: Backward-compatible new features
- **Patch Version Change**: Bug fixes

### Deprecation Policy

1. Deprecation notice (6 months in advance)
2. Continue operating with warning headers
3. Complete removal

```http
Deprecation: true
Sunset: Sat, 1 Jan 2026 00:00:00 GMT
Link: <https://docs.authrim.org/migration/v2>; rel="sunset"
```

---

## Support & Feedback

### Documentation

- **Main Documentation**: [README.md](../README.md)
- **Phase 5 Planning**: [PHASE5_PLANNING.md](../project-management/PHASE5_PLANNING.md)
- **API Inventory**: [API_INVENTORY.md](../project-management/API_INVENTORY.md)
- **Database Schema**: [database-schema.md](../architecture/database-schema.md)

### Issue Reporting

GitHub Issues: https://github.com/sgrastar/authrim/issues

### Contributions

Pull Requests Welcome: https://github.com/sgrastar/authrim/pulls

---

## Change History

- **2025-11-13**: Phase 5 Stage 2 Implementation
  - ✅ Implemented Passkey API (WebAuthn/FIDO2)
  - ✅ Implemented Magic Link API (passwordless email auth)
  - ✅ Implemented Consent API (OAuth consent screen)
  - ✅ Implemented Admin User Management API (full CRUD)
  - ✅ Implemented Admin Client Management API (read-only)
  - ✅ Implemented Admin Statistics API
  - 📄 Added comprehensive API documentation for all new endpoints
  - 📝 Updated API overview and status tracking
- **2025-11-13**: Initial version (Phase 5 Design)
  - OIDC Core APIs (implemented)
  - OIDC Extensions (implemented)
  - Added Phase 5 planned APIs
  - Added OpenAPI 3.1 specification
