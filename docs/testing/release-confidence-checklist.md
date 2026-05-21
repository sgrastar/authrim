---
title: 'Release Confidence Checklist'
project: Authrim
lang: en
date: 2026-05-20
status: draft
---

# Release Confidence Checklist

Use this checklist to decide which tests and checks are appropriate for a
change. It is not a requirement to run everything for every patch.

## 1. Universal Checks

For most code changes:

- run targeted package tests while iterating
- run typecheck for affected packages when practical
- add or update tests for behavior changes
- add a regression test for reproduced bugs when practical
- confirm generated coverage files are ignored
- document residual risk when a meaningful test cannot be added

## 2. Authentication Flow Changes

Examples: authorize, login challenge, consent, reauth, passkey, direct auth,
request object, PAR, JARM.

Recommended checks:

- `pnpm --filter @authrim/ar-auth test`
- relevant `test/integration` protocol flow tests
- decision-table cases for allow/reject decisions
- negative cases for missing, malformed, expired, replayed, or mismatched input
- side-effect assertions for session, challenge, grant, consent, audit, or log
  behavior

## 3. Token and Key Changes

Examples: token endpoint, client authentication, grants, refresh, token
exchange, introspection, revocation, JWE, JWKS, signing keys.

Recommended checks:

- `pnpm --filter @authrim/ar-token test`
- relevant `ar-auth`, `ar-discovery`, and `ar-lib-core` targeted tests
- deterministic clock tests for `exp`, `nbf`, `iat`, and token age
- negative cases for issuer, audience, `kid`, `alg`, malformed payload, and
  replay
- JWKS refresh, cache, and rotation behavior where applicable

## 4. Discovery, Router, and Domain Topology Changes

Examples: issuer resolution, WebFinger, metadata, CORS, CSRF, UI proxying,
host forwarding, custom domains, naked domains.

Recommended checks:

- `pnpm --filter @authrim/ar-discovery test`
- `pnpm --filter @authrim/ar-router test`
- relevant `test/integration` topology tests
- contract tests for metadata and JWKS shape
- CSRF/origin decision-table cases
- host and forwarded-header spoofing cases

## 5. Runtime Storage and Deployment Topology Changes

Examples: shared D1, tenant-specific D1, external DB, runtime profiles,
generated environment files, service bindings, migrations.

Recommended checks:

- package tests for the owning setup/core/management package
- `pnpm exec vitest run test/integration`
- generated environment validation for the target environment
- topology matrix cases for single-tenant, multi-tenant, shared D1, tenant D1,
  and external DB paths where relevant
- migration or schema guard tests when persistence contracts change

## 6. Logging, Audit, Queue, and Webhook Changes

Examples: operational logs, audit storage, redaction, queue consumers,
destinations, DLQ, webhook payloads.

Recommended checks:

- `pnpm --filter @authrim/ar-lib-core test`
- `pnpm --filter @authrim/ar-lib-logging test`
- relevant `ar-management` tests for admin-facing configuration
- redaction tests for sensitive details
- producer/consumer contract tests for queue payloads
- failure injection for delivery, storage, retry, and DLQ paths
- side-effect assertions for audit events and settings history

## 7. Admin, Policy, and Management API Changes

Examples: RBAC, ABAC/ReBAC, admin sessions, clients, users, settings, SCIM,
tenant operations.

Recommended checks:

- `pnpm --filter @authrim/ar-management test`
- `pnpm --filter @authrim/ar-lib-policy test`
- relevant `ar-lib-core` middleware and repository tests
- tenant or topology boundary tests when records are scoped
- permission matrix tests for allow/deny behavior
- audit/settings-history assertions for security-relevant configuration changes

## 8. UI and Browser-Visible Changes

Examples: login UI, admin UI, consent pages, passkey/WebAuthn, redirects,
accessibility.

Recommended checks:

- package-local UI tests
- Playwright tests for critical user flows
- accessibility checks for changed browser surfaces
- API assertions for backend state after admin UI setting changes
- browser storage, cookie, redirect, and navigation checks where relevant

## 9. External Interoperability Changes

Examples: OIDC conformance, FAPI, SAML, SCIM, VC wallet compatibility, external
IdP bridge behavior.

Recommended checks:

- targeted package tests for the protocol surface
- contract tests for metadata and payload shape
- mocked upstream/downstream provider tests
- conformance or compatibility environment checks when preparing a release
- negative cases for malformed, unsupported, or stale external input
