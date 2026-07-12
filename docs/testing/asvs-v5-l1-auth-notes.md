---
title: ASVS v5.0.0 Level 1 Authentication Notes
description: Initial Authrim scope notes for ASVS v5.0.0 V6/V7/V10.4 Level 1 coverage.
---

# ASVS v5.0.0 Level 1 Authentication Notes

This document records scope decisions for the initial ASVS v5.0.0 Level 1 Authentication
Session Management, and OAuth Authorization Server coverage trial. It is not a full compliance
claim, third-party audit, certification, or penetration-test attestation. Reported `covered`
requirements mean that the listed evidence currently covers the requirement in the stated scope.

## Current Password Scope

Authrim's primary local administrator setup is passwordless and uses passkey/WebAuthn. Authrim
also supports directory password login, but that flow delegates password verification to an
external connector instead of letting Authrim users set or change an Authrim-managed password.

For the initial ASVS V6/V7/V10.4 Level 1 trial, requirements about user-set password creation,
password-change flows, password blocklists during registration/change, and password composition
rules are marked `not_applicable` until Authrim introduces an Authrim-managed password lifecycle.

## Current Session Scope

Authrim uses backend reference sessions. Runtime cookies carry sharded session identifiers that
route to SessionStore Durable Objects; backend lookup enforces existence, expiration, and
user-level revocation epochs. Session identifiers are dynamically generated with a 128-bit CSPRNG
random component before sharding metadata is added.

The initial V7 Level 1 ledger intentionally records two gaps:

- Anonymous upgrade and re-authentication paths should rotate the session identifier and invalidate
  the previous session before ASVS V7.2.4 is treated as covered.
- Account disable and deletion paths should invoke all-session revocation automatically before ASVS
  V7.4.2 is treated as covered.

## Current OAuth Authorization Server Scope

The initial V10.4 Level 1 scope covers OAuth authorization server controls only. Authrim validates
registered redirect URIs by exact string comparison, stores authorization codes as one-time,
short-lived Durable Object state, and mitigates public-client refresh token replay with DPoP-bound
refresh tokens plus rotation.

The initial V10.4 Level 1 ledger intentionally records one gap:

- Token endpoint handlers should consistently enforce each client's allowed `grant_types`,
  especially for `authorization_code` and `refresh_token`, before ASVS V10.4.4 is treated as
  covered.

## Monthly Review Operation

ASVS checks are run manually instead of in PR CI. Run:

```sh
pnpm run asvs:check
```

The command writes the monthly report to `docs/reports/asvs/YYYY-MM/asvs-coverage.md` and updates
`docs/reports/asvs/README.md`.

## Manual Review Items

The following area intentionally starts as `manual`:

- ASVS-specific documentation for rate limiting, anti-automation, adaptive responses, and
  malicious account lockout prevention.

The initial trial also includes independent ASVS checks for default-account seeding, setup-token
entropy and expiry, Admin UI passkey setup token lifecycle fields, absence of password hints or
knowledge-based authentication surfaces, backend session verification, dynamic reference-token
issuance, reference-token entropy, logout/session-store invalidation, redirect URI registration
checks, authorization-code single-use/expiry, authorization-code binding, and public-client refresh
token replay protection.

## Expansion Plan

After this V6/V7/V10.4 Level 1 trial is stable, close the recorded session-rotation,
account disable/delete revocation, and client grant restriction gaps, then expand the ledger to
additional OAuth/OIDC requirements and Level 2 controls.
