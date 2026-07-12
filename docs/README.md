---
project: Authrim
lang: en
date: 2026-01-07
description: 'Documentation for the Authrim OpenID Connect Provider project.'
type: reference
tags:
  - authrim
  - oidc
  - documentation
---

# Authrim Documentation

Documentation for the Authrim OpenID Connect Provider project.

---

## 📋 Overview

| Document                                                         | Description                                                                                                                                                 |
| :--------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Public Specification](./specification/authrim-specification.md) | Public runtime contract covering API endpoints, defaults, session profiles, storage portability, audit, security behavior, and Workers-native UI deployment |
| [Feature Matrix](./FEATURES.md)                                  | Feature and SDK capability matrix                                                                                                                           |
| [Vision](./VISION.md)                                            | Long-term vision and strategic goals                                                                                                                        |
| [Roadmap](./ROADMAP.md)                                          | Product roadmap and feature status                                                                                                                          |
| [Access Control](./access-control.md)                            | RBAC, ABAC, and ReBAC architecture and usage                                                                                                                |
| [Admin Jobs](./admin-jobs.md)                                    | Tenant-scoped asynchronous Admin Jobs, result artifacts, retry state, and UI behavior                                                                       |
| [Directory Authentication Public Summary](./directory-authentication-public-summary.md) | Public summary for Directory Authentication and Authrim Wordwarden security and compliance reviews                                                          |
| [Testing Documentation](./testing/README.md)                     | Lightweight ISO/IEC/IEEE 29119-aligned testing profile, regression bank, and release confidence checklist                                                   |
| [SAML Production Readiness](./saml-production-readiness.md)      | SAML metadata, signing rollover, attribute presets, SLO fanout observation, and operational limits                                                          |
| [Security and QA Roadmap](./ROADMAP.md#security-qa-and-validation) | Current security-validation status, remaining hardening tasks, and release-readiness criteria                                                               |

---

## Security Hardening Notes

Authrim is pre-1.0 and security validation is ongoing. Recent internal review remediation
covered selected management API authorization gates, CIBA client authentication, admin setup-token
fail-closed behavior, Admin WebAuthn origin/RP ID validation, OTP HMAC secret handling,
VCI holder binding, device-flow single-use token issuance, and SCIM filter fail-closed
behavior.

Remaining work includes a declarative fail-closed Admin API permission table with CI
coverage for undeclared routes, lower-severity hardening items, and an external audit or
penetration test before production-stability claims.

---

## 🚀 Getting Started

Guides for development and deployment.

| Document                                              | Description                                |
| :---------------------------------------------------- | :----------------------------------------- |
| [Development Guide](./getting-started/development.md) | Development environment setup and workflow |
| [Deployment Guide](./getting-started/deployment.md)   | Deploying to Cloudflare Workers            |
| [Testing Guide](./getting-started/testing.md)         | Testing strategy and test execution        |

---

## 📚 External Resources

### OpenID Connect Specifications

- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)
- [Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html)

### OAuth 2.0 Specifications

- [RFC 6749 - OAuth 2.0 Framework](https://datatracker.ietf.org/doc/html/rfc6749)
- [RFC 6750 - Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750)
- [RFC 9126 - Pushed Authorization Requests](https://datatracker.ietf.org/doc/html/rfc9126)

### Technology Stack

- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Hono Framework](https://hono.dev/)
- [JOSE Library](https://github.com/panva/jose)

---

> **Authrim** — Edge-native OpenID Connect Provider
