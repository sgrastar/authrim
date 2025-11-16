# Enrai API Endpoints List

**Last Updated**: 2025-11-16
**Total Endpoints**: 42

This document provides a concise list of all available API endpoints in Enrai OIDC Provider.

---

## OIDC Discovery

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/.well-known/openid-configuration` | OpenID Connect discovery document |
| GET | `/.well-known/jwks.json` | JSON Web Key Set for token verification |

---

## OIDC Core

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET, POST | `/authorize` | OAuth 2.0/OIDC authorization endpoint |
| POST | `/token` | Token endpoint for exchanging authorization codes and refresh tokens |
| GET, POST | `/userinfo` | User information endpoint (requires access token) |

---

## OIDC Extensions

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/as/par` | Pushed Authorization Request (RFC 9126) |
| POST | `/register` | Dynamic Client Registration (RFC 7591) |
| POST | `/introspect` | Token introspection (RFC 7662) |
| POST | `/revoke` | Token revocation (RFC 7009) |

---

## Authentication

### Passkey (WebAuthn/FIDO2)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/passkey/register/options` | Generate passkey registration options |
| POST | `/api/auth/passkey/register/verify` | Verify and complete passkey registration |
| POST | `/api/auth/passkey/login/options` | Generate passkey authentication options |
| POST | `/api/auth/passkey/login/verify` | Verify passkey authentication response |

### Magic Link

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/magic-link/send` | Send magic link email for passwordless login |
| GET | `/api/auth/magic-link/verify` | Verify magic link token and authenticate user |

### Consent

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/auth/consent` | Retrieve consent screen data for authorization |
| POST | `/api/auth/consent` | Submit user consent decision (allow/deny) |

---

## Session Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sessions/issue` | Issue session token for cross-domain SSO |
| POST | `/api/sessions/verify` | Verify session token validity |
| GET | `/api/sessions/status` | Check current session status |
| POST | `/api/sessions/refresh` | Refresh and extend session expiration |

---

## Logout

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/logout` | Front-channel logout endpoint |
| POST | `/logout/backchannel` | Back-channel logout (RFC 8725) |

---

## Admin API

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/users` | List all users with pagination and search |
| GET | `/api/admin/users/:id` | Get specific user details by ID |
| POST | `/api/admin/users` | Create new user account |
| PUT | `/api/admin/users/:id` | Update existing user information |
| DELETE | `/api/admin/users/:id` | Delete user account |
| POST | `/api/admin/users/:id/avatar` | Upload user avatar image |
| DELETE | `/api/admin/users/:id/avatar` | Delete user avatar image |
| DELETE | `/api/admin/users/:id/sessions` | Revoke all sessions for specific user |

### Clients

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/clients` | List all registered OAuth clients |
| GET | `/api/admin/clients/:id` | Get specific client details by ID |

### Sessions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/sessions` | List all active sessions with filtering |
| GET | `/api/admin/sessions/:id` | Get specific session details by ID |
| DELETE | `/api/admin/sessions/:id` | Revoke specific session |

### Statistics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Get system statistics and recent activity |

### Avatars

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/avatars/:filename` | Serve user avatar images |

---

## Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check endpoint (available on all workers) |

---

## Notes

### Authentication Requirements

- **Public Endpoints**: Discovery, Authorization, Token, Health Check
- **User Authentication**: UserInfo, Consent, Session Management, Logout
- **Admin Authentication**: All `/api/admin/*` endpoints require admin privileges
- **Client Authentication**: Token, Introspect, Revoke endpoints

### Rate Limiting

All endpoints are protected by rate limiting. See [API Documentation](./api/README.md#rate-limiting) for details.

### Detailed Documentation

For comprehensive API documentation including request/response examples, error codes, and authentication details, refer to:

- [Complete API Documentation](./api/README.md)
- [OpenAPI Specification](./api/openapi.yaml)
- [Admin API Documentation](./api/admin/)
- [Auth API Documentation](./api/auth/)

---

## References

- **OpenID Connect Core 1.0**: https://openid.net/specs/openid-connect-core-1_0.html
- **OAuth 2.0 (RFC 6749)**: https://tools.ietf.org/html/rfc6749
- **RFC 7591**: Dynamic Client Registration Protocol
- **RFC 7662**: OAuth 2.0 Token Introspection
- **RFC 7009**: OAuth 2.0 Token Revocation
- **RFC 9126**: OAuth 2.0 Pushed Authorization Requests
- **RFC 8725**: JSON Web Token Best Current Practices
- **WebAuthn Level 2**: https://www.w3.org/TR/webauthn-2/
