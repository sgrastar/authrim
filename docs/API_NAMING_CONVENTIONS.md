# API Naming Conventions

This document defines the naming conventions and best practices for Enrai's API endpoints.

## Table of Contents

- [Overview](#overview)
- [API Categories](#api-categories)
- [Naming Rules](#naming-rules)
- [RESTful Principles](#restful-principles)
- [Complete API Reference](#complete-api-reference)
- [Error Response Format](#error-response-format)
- [Versioning Strategy](#versioning-strategy)

---

## Overview

Enrai's API is divided into two main categories:

1. **OIDC Standard Endpoints** - Paths defined by OpenID Connect and OAuth 2.0 specifications
2. **Custom API Endpoints** - Enrai-specific APIs with `/api/` prefix

### Design Principles

- ✅ **Follow OpenID Connect and OAuth 2.0 standards** for standard endpoints
- ✅ **Use `/api/` prefix** for all custom endpoints
- ✅ **Follow RESTful principles** (use HTTP methods, avoid verbs in paths)
- ✅ **Use hierarchical structure** for resource relationships
- ✅ **Keep paths lowercase** with hyphens for readability
- ✅ **Be consistent** across all endpoints

---

## API Categories

### 1. OIDC Standard Endpoints

These endpoints follow OpenID Connect and OAuth 2.0 specifications and **must not** have the `/api/` prefix.

```
/.well-known/openid-configuration   # OIDC Discovery (RFC 8414)
/.well-known/jwks.json              # JSON Web Key Set (RFC 7517)
/authorize                          # Authorization Endpoint (OIDC Core)
/token                              # Token Endpoint (OIDC Core)
/userinfo                           # UserInfo Endpoint (OIDC Core)
/register                           # Dynamic Client Registration (RFC 7591)
/introspect                         # Token Introspection (RFC 7662)
/revoke                             # Token Revocation (RFC 7009)
/logout                             # Front-channel Logout
/logout/backchannel                 # Back-channel Logout (OIDC Back-Channel Logout)
/as/par                             # Pushed Authorization Requests (RFC 9126)
```

**Important:** These paths are part of the OIDC specification and should never be changed.

---

### 2. Custom API Endpoints

All custom endpoints **must** use the `/api/` prefix to clearly distinguish them from OIDC standard endpoints.

#### Structure:
```
/api/
├── health                          # Health check
├── auth/                           # Authentication APIs
├── sessions/                       # Session management
├── admin/                          # Admin APIs
└── avatars/                        # Static resources
```

---

## Naming Rules

### Rule 1: Use `/api/` Prefix for Custom Endpoints

**✅ Correct:**
```
/api/auth/passkey/login/options
/api/admin/users
/api/sessions/status
```

**❌ Incorrect:**
```
/auth/passkey/login/options         # Missing /api/ prefix
/admin/users                        # Missing /api/ prefix
```

---

### Rule 2: Avoid Verbs in Path Names

Use HTTP methods (GET, POST, PUT, DELETE) to represent actions instead of verbs in the path.

**✅ Correct:**
```http
POST   /api/auth/magic-link/send      # "send" is domain-specific, acceptable
POST   /api/sessions/verify           # "verify" is domain-specific, acceptable
DELETE /api/admin/sessions/:id        # Use DELETE method for revocation
```

**❌ Incorrect:**
```http
POST /api/admin/sessions/:id/revoke   # "revoke" is redundant with DELETE
POST /api/admin/users/:id/delete      # Use DELETE method instead
GET  /api/admin/users/get/:id         # "get" is redundant with GET
```

**Exception:** Some domain-specific verbs are acceptable when they represent a specific business action:
- `/send` - Sending emails or notifications
- `/verify` - Verification operations
- `/issue` - Issuing tokens or credentials
- `/refresh` - Refreshing resources

---

### Rule 3: Use Hierarchical Structure

Represent resource relationships using path hierarchy.

**✅ Correct:**
```
GET    /api/admin/users/:id/sessions      # Get all sessions for a user
DELETE /api/admin/users/:id/sessions      # Delete all sessions for a user
GET    /api/admin/users/:id/avatar        # Get user's avatar
POST   /api/admin/users/:id/avatar        # Upload user's avatar
DELETE /api/admin/users/:id/avatar        # Delete user's avatar
```

**❌ Incorrect:**
```
POST /api/admin/users/:id/revoke-all-sessions  # Too verbose
GET  /api/admin/user-avatar/:id                # Flat structure
```

---

### Rule 4: Use Plural Nouns for Collections

**✅ Correct:**
```
GET  /api/admin/users           # List of users
GET  /api/admin/clients         # List of clients
GET  /api/admin/sessions        # List of sessions
```

**❌ Incorrect:**
```
GET  /api/admin/user            # Should be plural
GET  /api/admin/client          # Should be plural
```

---

### Rule 5: Use Lowercase with Hyphens

**✅ Correct:**
```
/api/auth/magic-link/send
/api/admin/audit-logs
```

**❌ Incorrect:**
```
/api/auth/magicLink/send        # camelCase
/api/auth/magic_link/send       # snake_case
/api/admin/auditLogs            # camelCase
```

---

## RESTful Principles

### HTTP Methods and Their Usage

| Method | Usage | Idempotent | Safe |
|--------|-------|-----------|------|
| **GET** | Retrieve resource(s) | ✅ | ✅ |
| **POST** | Create resource or perform action | ❌ | ❌ |
| **PUT** | Update resource (replace) | ✅ | ❌ |
| **PATCH** | Update resource (partial) | ❌ | ❌ |
| **DELETE** | Delete resource | ✅ | ❌ |

### Examples

#### User Management
```http
GET    /api/admin/users              # List all users
POST   /api/admin/users              # Create a new user
GET    /api/admin/users/:id          # Get user details
PUT    /api/admin/users/:id          # Update user (full replacement)
PATCH  /api/admin/users/:id          # Update user (partial)
DELETE /api/admin/users/:id          # Delete user
```

#### Session Management
```http
GET    /api/admin/sessions           # List all sessions
GET    /api/admin/sessions/:id       # Get session details
DELETE /api/admin/sessions/:id       # Revoke a session
```

#### Nested Resources
```http
GET    /api/admin/users/:id/sessions        # Get all sessions for a user
DELETE /api/admin/users/:id/sessions        # Revoke all sessions for a user
POST   /api/admin/users/:id/avatar          # Upload avatar for a user
DELETE /api/admin/users/:id/avatar          # Delete avatar for a user
```

---

## Complete API Reference

### Authentication APIs (`/api/auth/`)

#### Passkey Authentication
```http
POST /api/auth/passkey/register/options     # Get Passkey registration options
POST /api/auth/passkey/register/verify      # Verify Passkey registration
POST /api/auth/passkey/login/options        # Get Passkey login options
POST /api/auth/passkey/login/verify         # Verify Passkey login
```

#### Magic Link Authentication
```http
POST /api/auth/magic-link/send              # Send magic link to email
GET  /api/auth/magic-link/verify            # Verify magic link token
```

#### Consent (UI Helper)
```http
GET  /api/auth/consent                      # Display consent page data
POST /api/auth/consent                      # Submit consent decision
```

---

### Session Management APIs (`/api/sessions/`)

```http
POST /api/sessions/issue                    # Issue a new session token
POST /api/sessions/verify                   # Verify session token
GET  /api/sessions/status                   # Check session status
POST /api/sessions/refresh                  # Refresh session expiration
```

**Design Note:** All session-related operations are grouped under `/api/sessions/` for consistency.

---

### Admin APIs (`/api/admin/`)

#### Statistics
```http
GET /api/admin/stats                        # Get dashboard statistics
```

#### User Management
```http
GET    /api/admin/users                     # List users (with pagination & search)
POST   /api/admin/users                     # Create a new user
GET    /api/admin/users/:id                 # Get user details
PUT    /api/admin/users/:id                 # Update user
DELETE /api/admin/users/:id                 # Delete user
POST   /api/admin/users/:id/avatar          # Upload user avatar
DELETE /api/admin/users/:id/avatar          # Delete user avatar
```

**Query Parameters for User List:**
```
?page=1              # Page number (default: 1)
&limit=20            # Items per page (default: 20)
&search=email        # Search by email or name
&verified=true       # Filter by email_verified status
```

#### Client Management
```http
GET /api/admin/clients                      # List OAuth clients
GET /api/admin/clients/:id                  # Get client details
```

#### Session Management
```http
GET    /api/admin/sessions                  # List all sessions
GET    /api/admin/sessions/:id              # Get session details
DELETE /api/admin/sessions/:id              # Revoke a session
DELETE /api/admin/users/:id/sessions        # Revoke all sessions for a user
```

---

### Resource APIs

#### Avatars
```http
GET /api/avatars/:filename                  # Serve avatar image
```

#### Health Check
```http
GET /api/health                             # Service health status
```

---

## Error Response Format

All API errors follow the OAuth 2.0 error response format (RFC 6749):

```json
{
  "error": "invalid_request",
  "error_description": "Missing required parameter: email",
  "error_uri": "https://docs.enrai.dev/errors/invalid_request"
}
```

### Standard Error Codes

| Error Code | HTTP Status | Description |
|-----------|-------------|-------------|
| `invalid_request` | 400 | Request is malformed or missing parameters |
| `unauthorized_client` | 401 | Client authentication failed |
| `access_denied` | 403 | User denied access or insufficient permissions |
| `unsupported_response_type` | 400 | Unsupported response type |
| `invalid_scope` | 400 | Invalid scope requested |
| `server_error` | 500 | Internal server error |
| `temporarily_unavailable` | 503 | Service temporarily unavailable |

### Custom Error Codes (Enrai-specific)

| Error Code | HTTP Status | Description |
|-----------|-------------|-------------|
| `user_not_found` | 404 | User does not exist |
| `passkey_not_supported` | 400 | WebAuthn not supported by browser |
| `magic_link_expired` | 400 | Magic link token has expired |
| `session_expired` | 401 | Session has expired |
| `rate_limit_exceeded` | 429 | Too many requests |

---

## Versioning Strategy

### Current Approach (No Versioning)

Enrai currently does not use API versioning. All endpoints are considered **v1** implicitly.

### Future Versioning (When Needed)

If breaking changes are required, we will introduce versioning:

```
/api/v1/auth/passkey/login/options
/api/v2/auth/passkey/login/options
```

**Principles:**
- Maintain backward compatibility whenever possible
- Deprecate old versions with a clear migration path
- Document breaking changes in `CHANGELOG.md`

### Environment Variable Support

```typescript
const API_VERSION = env.API_VERSION || 'v1';
app.use(`/api/${API_VERSION}/*`, ...);
```

---

## Rate Limiting Headers

All API responses include rate limiting headers:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

---

## Summary

### Quick Reference

| Category | Prefix | Examples |
|----------|--------|----------|
| **OIDC Standard** | None | `/authorize`, `/token`, `/userinfo` |
| **Custom Auth** | `/api/auth/` | `/api/auth/passkey/*`, `/api/auth/magic-link/*` |
| **Sessions** | `/api/sessions/` | `/api/sessions/issue`, `/api/sessions/verify` |
| **Admin** | `/api/admin/` | `/api/admin/users`, `/api/admin/clients` |
| **Resources** | `/api/` | `/api/avatars/:filename`, `/api/health` |

### Best Practices Checklist

- [ ] Use `/api/` prefix for all custom endpoints
- [ ] Avoid verbs in path names (use HTTP methods)
- [ ] Use plural nouns for collections
- [ ] Use lowercase with hyphens
- [ ] Follow hierarchical structure for nested resources
- [ ] Return proper HTTP status codes
- [ ] Include rate limiting headers
- [ ] Follow OAuth 2.0 error response format

---

**Last Updated:** 2025-01-15
**Version:** 1.0.0
