# Authrim API Inventory

**Last Updated**: 2025-12-01
**Status**: Phase 6 (8/11 Enterprise Features Complete) + Policy Service

---

## Overview

This document records the current status of all API endpoints in Authrim.

> **API Specifications**: [OpenAPI 3.1 Specification](../api/openapi.yaml) | [API Guide](../api/README.md)

### Statistics Summary

| Category | Implemented | Planned | Total |
|----------|-------------|---------|-------|
| **OIDC Core** | 7 | 0 | 7 |
| **OIDC Extensions** | 4 | 0 | 4 |
| **Advanced Flows** | 6 | 0 | 6 |
| **Auth UI** | 6 | 0 | 6 |
| **Admin API** | 9 | 0 | 9 |
| **Session/Logout** | 6 | 0 | 6 |
| **Policy/ReBAC** | 7 | 0 | 7 |
| **Enterprise** | 4 | 3 | 7 |
| **Total** | **49** | **3** | **52** |

---

## OIDC Core APIs ✅ Implemented

| Endpoint | Method | Status | RFC/Spec |
|----------|--------|--------|----------|
| `/.well-known/openid-configuration` | GET | ✅ | OIDC Discovery |
| `/.well-known/jwks.json` | GET | ✅ | OIDC Core |
| `/authorize` | GET | ✅ | OIDC Core 3.1.2 |
| `/authorize` | POST | ✅ | OIDC Core 3.1.2.1 |
| `/token` | POST | ✅ | OIDC Core 3.1.3 |
| `/userinfo` | GET | ✅ | OIDC Core 5.3 |
| `/userinfo` | POST | ✅ | OIDC Core 5.3.1 |

**Features**:
- PKCE Support (RFC 7636)
- Claims Parameter Support (OIDC Core 5.5)
- All Standard Scopes (openid, profile, email, address, phone)
- Token Revocation on Code Reuse

---

## OIDC Extensions ✅ Implemented

| Endpoint | Method | Status | RFC/Spec |
|----------|--------|--------|----------|
| `/register` | POST | ✅ | RFC 7591 (DCR) |
| `/as/par` | POST | ✅ | RFC 9126 (PAR) |
| `/introspect` | POST | ✅ | RFC 7662 |
| `/revoke` | POST | ✅ | RFC 7009 |

**Additional Features**:
- DPoP Support (RFC 9449)
- Pairwise Subject Identifiers (OIDC Core 8.1)
- Refresh Token with Rotation
- Form Post Response Mode

---

## Advanced Flows ✅ Implemented

| Endpoint | Method | Status | RFC/Spec |
|----------|--------|--------|----------|
| `/device/code` | POST | ✅ | RFC 8628 (Device Flow) |
| `/device/verify` | GET/POST | ✅ | RFC 8628 |
| `/ciba` | POST | ✅ | OIDC CIBA |
| `/ciba/pending` | GET | ✅ | CIBA Poll Mode |
| `/ciba/approve` | POST | ✅ | CIBA UI |
| `/ciba/deny` | POST | ✅ | CIBA UI |

**Features**:
- Hybrid Flow (code id_token, code token, code id_token token)
- JAR (RFC 9101) - JWT-Secured Authorization Requests
- JARM - JWT-Secured Authorization Response Mode
- JWE (RFC 7516) - ID Token and UserInfo encryption
- JWT Bearer Flow (RFC 7523)

---

## Auth UI APIs ✅ Implemented

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/auth/passkey/register` | POST | ✅ | Start Passkey registration |
| `/auth/passkey/verify` | POST | ✅ | Verify Passkey |
| `/auth/email-code/send` | POST | ✅ | Send email verification code |
| `/auth/email-code/verify` | POST | ✅ | Verify email code |
| `/auth/consent` | GET | ✅ | Get consent screen data |
| `/auth/consent` | POST | ✅ | Confirm consent |

---

## Admin APIs ✅ Implemented

### User Management

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/admin/users` | GET | ✅ | List/Search users |
| `/admin/users` | POST | ✅ | Create user |
| `/admin/users/:id` | GET | ✅ | Get user details |
| `/admin/users/:id` | PUT | ✅ | Update user |
| `/admin/users/:id` | DELETE | ✅ | Delete user |

### Client Management

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/admin/clients` | GET | ✅ | List clients |
| `/admin/clients` | POST | ✅ | Create client |
| `/admin/clients/:id` | PUT | ✅ | Update client |
| `/admin/clients/:id` | DELETE | ✅ | Delete client |

### Statistics

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/admin/stats` | GET | ✅ | System statistics |

---

## Session & Logout APIs ✅ Implemented

### Session Management

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/auth/session/token` | POST | ✅ | Issue short-lived token (5 min TTL) |
| `/auth/session/verify` | POST | ✅ | Verify token & establish RP session |
| `/session/status` | GET | ✅ | Check IdP session validity |
| `/session/refresh` | POST | ✅ | Extend session (Active TTL) |

### Logout

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/logout` | GET | ✅ | Front-channel Logout |
| `/logout/backchannel` | POST | ✅ | Back-channel Logout (RFC 8725) |

---

## Policy & ReBAC APIs ✅ Implemented

Policy Service provides centralized access control for RBAC/ABAC/ReBAC.

**Authentication**: All endpoints (except health) require Bearer token (`POLICY_API_SECRET`).

### Policy Endpoints

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/policy/health` | GET | ✅ | Health check |
| `/policy/evaluate` | POST | ✅ | Full policy evaluation (subject, resource, action) |
| `/policy/check-role` | POST | ✅ | Quick role check (single or multiple) |
| `/policy/check-access` | POST | ✅ | Simplified access check |
| `/policy/is-admin` | POST | ✅ | Admin status check |

### ReBAC Endpoints (Zanzibar-style)

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/api/rebac/health` | GET | ✅ | ReBAC health check |
| `/api/rebac/check` | POST | ✅ | Relationship check (subject, relation, object) |

**Routing**:
- Custom domain: `/policy/*` and `/api/rebac/*` routed directly to policy-service
- workers.dev: Endpoints available at root level via router (e.g., `/health`, `/evaluate`)

---

## Enterprise APIs

### SCIM 2.0 ✅ Implemented

| Endpoint | Method | Status | Purpose |
|----------|--------|--------|---------|
| `/scim/v2/Users` | GET | ✅ | List/Search users |
| `/scim/v2/Users` | POST | ✅ | Create user |
| `/scim/v2/Users/:id` | GET | ✅ | Get user |
| `/scim/v2/Users/:id` | PUT | ✅ | Replace user |
| `/scim/v2/Users/:id` | PATCH | ✅ | Update user |
| `/scim/v2/Users/:id` | DELETE | ✅ | Delete user |
| `/scim/v2/Groups` | GET | ✅ | List/Search groups |
| `/scim/v2/Groups` | POST | ✅ | Create group |
| `/scim/v2/Groups/:id` | GET | ✅ | Get group |
| `/scim/v2/Groups/:id` | PUT | ✅ | Replace group |
| `/scim/v2/Groups/:id` | PATCH | ✅ | Update group |
| `/scim/v2/Groups/:id` | DELETE | ✅ | Delete group |
| `/scim/v2/Schemas` | GET | ✅ | List schemas |
| `/scim/v2/ServiceProviderConfig` | GET | ✅ | Provider configuration |

### Planned APIs

| Feature | Endpoints | Status |
|---------|-----------|--------|
| Social Login | `/auth/social/:provider` | 🔜 Planned |
| SAML 2.0 Bridge | `/saml/metadata`, `/saml/sso`, `/saml/slo` | 🔜 Planned |
| LDAP Integration | Internal (no public API) | 🔜 Planned |

---

## Future Extensions (Phase 7+)

### CLI & Automation (Phase 7)

- Deployment APIs
- Configuration management

### Verifiable Credentials (Phase 8)

- OpenID4VP - Verifiable Presentations API
- OpenID4CI - Credential Issuance API
- OpenID Federation - Trust Chain API

### SaaS Platform (Phase 9)

- Multi-tenant APIs
- Billing APIs
- Marketplace APIs

---

## References

### Standards

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [RFC 6749 - OAuth 2.0](https://tools.ietf.org/html/rfc6749)
- [RFC 7591 - Dynamic Client Registration](https://tools.ietf.org/html/rfc7591)
- [RFC 7662 - Token Introspection](https://tools.ietf.org/html/rfc7662)
- [RFC 7009 - Token Revocation](https://tools.ietf.org/html/rfc7009)
- [RFC 8628 - Device Authorization Grant](https://tools.ietf.org/html/rfc8628)
- [RFC 9126 - PAR](https://tools.ietf.org/html/rfc9126)
- [RFC 9449 - DPoP](https://tools.ietf.org/html/rfc9449)
- [RFC 9101 - JAR](https://tools.ietf.org/html/rfc9101)
- [RFC 7643/7644 - SCIM 2.0](https://tools.ietf.org/html/rfc7643)

### Related Documents

- [OpenAPI Specification](../api/openapi.yaml)
- [API README](../api/README.md)
- [Database Schema](../architecture/database-schema.md)
- [Roadmap](../ROADMAP.md)

---

> **Last Update**: 2025-12-01
