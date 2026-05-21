---
title: 'ISO/IEC/IEEE 29119-4 Test Techniques - Lightweight Test Profile'
project: Authrim
lang: en
date: 2026-05-20
status: draft
---

# ISO/IEC/IEEE 29119-4 Test Techniques - Lightweight Test Profile

## 1. Purpose

This document defines the test design techniques Authrim uses for meaningful
coverage of authentication and authorization behavior. It is aligned with the
technique-oriented intent of ISO/IEC/IEEE 29119-4, while focusing on practical
techniques for this codebase.

## 2. Technique Selection

Use techniques according to risk.

| Risk level | Typical areas                                                        | Required techniques                                                    |
| ---------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Critical   | auth bypass, token acceptance, tenant isolation, key selection       | decision tables, negative tests, branch coverage, MC/DC-style evidence |
| High       | admin authorization, consent, redirect/origin checks, session/logout | decision tables, boundary values, state transition tests               |
| Medium     | setup, management CRUD, logging configuration, queue consumers       | equivalence partitions, failure injection, contract tests              |
| Low        | formatting, non-security metadata, simple pass-through routes        | representative unit or component tests                                 |

## 3. Specification-Based Techniques

### 3.1 Equivalence Partitioning

Use for inputs where values can be grouped into valid and invalid classes.

Examples:

- valid and invalid `client_id`
- supported and unsupported grant types
- valid and invalid response modes
- accepted and rejected token endpoint authentication methods
- known and unknown tenant identifiers

Minimum expectation:

- at least one valid representative
- at least one invalid representative
- explicit tests for missing values when required

### 3.2 Boundary Value Analysis

Use for numeric or time-based boundaries.

Examples:

- token expiration and not-before time
- authorization code lifetime
- device code interval and expiration
- CIBA polling interval and slow-down behavior
- pagination limits
- retry counts and backoff thresholds

Minimum expectation:

- just below boundary
- at boundary
- just above boundary
- missing or malformed value when applicable

### 3.3 Decision Table Testing

Use for authorization, validation, and routing decisions with multiple
conditions.

Required for:

- redirect URI validation
- client authentication
- PKCE validation
- tenant and issuer resolution
- CORS, Origin, Referer, and CSRF validation
- admin role checks
- scope and consent decisions
- JWK key selection

Decision tables should identify each condition and include cases where changing
one relevant condition changes the outcome.

### 3.4 State Transition Testing

Use when behavior depends on lifecycle state.

Required for:

- authorization code lifecycle
- refresh token rotation
- device authorization
- CIBA request status
- sessions
- logout
- invite and setup flows
- queue delivery and dead-letter handling

Minimum expectation:

- allowed transitions
- rejected transitions
- expired states
- replayed or duplicate operations

### 3.5 Use Case and Scenario Testing

Use for protocol and user journeys.

Examples:

- authorization code flow
- refresh token flow
- device flow
- CIBA ping/poll behavior
- admin setup flow
- external IdP callback handling
- tenant-specific discovery and issuer resolution

### 3.6 Matrix-Driven Testing

Use matrix-driven testing when combinations matter more than single examples.
Authrim uses this approach for runtime topology, protocol, and storage-boundary
behavior through machine-readable fixtures and local integration tests.

Recommended matrix areas:

- single-tenant vs multi-tenant mode
- domain topology, including naked domains, subdomains, and custom domains
- issuer behavior for primary and non-primary authorities
- discovery input source and fallback behavior
- entry route, redirect, and grant verification behavior
- cookie/session behavior across host and domain boundaries
- runtime storage topology such as shared D1, tenant-specific D1, and external
  database paths
- setup-generated environment shape, service bindings, and runtime profile
  selection
- negative cases for cross-tenant, tampered, inactive, or stale input

Matrix tests should remain local Vitest integration tests when they can verify
the behavior without a browser. Use Playwright only when page rendering,
browser storage, WebAuthn, or user-visible navigation is the risk under test.

## 4. Structure-Based Techniques

### 4.1 Line and Statement Coverage

Line and statement coverage help identify untested code, but they do not prove
security behavior. They should be used as baseline signals.

### 4.2 Branch Coverage

Branch coverage is required for security-sensitive packages because many
authentication failures are represented as conditional branches.

Priority branches:

- allow vs reject
- trusted vs untrusted client
- same-tenant vs cross-tenant
- authenticated vs unauthenticated
- configured vs fallback behavior
- storage success vs storage failure

### 4.3 Condition Coverage

Condition coverage should be used when a decision combines multiple boolean
conditions.

Examples:

```text
allowed = originAllowed && tenantMatches && methodAllowed
```

Tests should show each condition in both true and false states where relevant.

### 4.4 MC/DC-Style Evidence

MC/DC-style evidence is required for critical security decisions when a compact
decision table is practical. The goal is to demonstrate that each important
condition can independently affect the decision outcome.

This repository does not require a formal MC/DC tool gate at this stage.
Instead, critical test files should include explicit table-driven cases that
make the independent effect visible.

Recommended case shape:

| Case      | C1    | C2    | C3    | Result | Purpose                         |
| --------- | ----- | ----- | ----- | ------ | ------------------------------- |
| baseline  | true  | true  | true  | allow  | all conditions satisfied        |
| C1 impact | false | true  | true  | reject | C1 independently changes result |
| C2 impact | true  | false | true  | reject | C2 independently changes result |
| C3 impact | true  | true  | false | reject | C3 independently changes result |

## 5. Experience-Based Techniques

### 5.1 Error Guessing

Use known authentication failure patterns:

- missing required parameter
- wrong issuer
- wrong audience
- expired token
- token replay
- `none` or unexpected algorithm
- wrong `kid`
- same host with different scheme
- lookalike redirect URI
- spoofed forwarded host headers
- cross-tenant host and issuer mismatch
- malformed JSON or form payload

### 5.2 Checklist-Based Testing

For security-sensitive changes, reviewers should check:

- Does the test include both allow and reject paths?
- Does malformed input fail closed?
- Does the error response avoid leaking secrets?
- Does tenant-specific behavior use the correct issuer?
- Are producer payload schemas unchanged unless explicitly required?
- Are logs and audit events redacted?
- Does storage failure return a controlled error?

### 5.3 Exploratory Testing

Use exploratory testing for new flows, admin UI integration, browser redirects,
and unusual tenant/domain combinations. Record findings as tests whenever a
repeatable behavior or defect is identified.

## 6. Property-Based and Fuzz Testing

Property-based or fuzz testing should be considered for:

- redirect URI parsing
- origin validation
- issuer and host derivation
- scope parsing
- token claim validation
- JWK selection
- header normalization

These techniques are optional until the target area is stable enough to avoid
high maintenance cost.

## 7. Mutation Testing

Mutation testing is useful for verifying that tests detect meaningful logic
changes. Authrim may introduce mutation testing later for a narrow set of
critical modules.

Candidate areas:

- redirect URI validation
- client authentication
- PKCE
- token claim validation
- tenant issuer resolution
- CSRF and origin validation

Mutation testing should not be applied monorepo-wide until runtime cost and
false-positive handling are understood.

## 8. Feature Suite Taxonomy

Authrim should keep package tests organized by product and protocol feature,
not only by implementation file. This makes gaps visible without requiring a
large external test framework.

| Package                | Feature suites to maintain                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `ar-auth`              | authorize, interaction, consent, PAR, request object/JAR, JARM, logout, session, passkey    |
| `ar-token`             | client authentication, grant validation, refresh, introspection, revocation, token exchange |
| `ar-discovery`         | OIDC metadata, OAuth metadata, JWKS, WebFinger, tenant issuer, profile metadata             |
| `ar-router`            | service routing, host forwarding, CORS, CSRF, UI proxying, static asset fallback            |
| `ar-async`             | device authorization, device verification, CIBA authorization, CIBA approval, CIBA polling  |
| `ar-management`        | clients, settings, admin auth, RBAC, audit, logging control, webhooks, tenant operations    |
| `ar-lib-core`          | tenant context, repositories, middleware, audit services, storage, crypto-adjacent helpers  |
| `ar-lib-logging`       | policy, redaction, chunking, delivery, destination validation, key handling                 |
| `ar-bridge`            | external IdP start/callback, state, PKCE, linking, JIT provisioning, backchannel logout     |
| `ar-saml`              | metadata, bindings, relay state, SSO, SLO, admin provider configuration                     |
| `setup`                | generated env, migrations, deployment wiring, smoke clients, CLI output, resource naming    |
| `test/integration`     | protocol flows, topology/storage matrices, generated environment validation                 |
| `test-e2e` / UI suites | login critical path, consent, admin settings, passkey/WebAuthn, accessibility               |

The taxonomy is a planning aid. It does not require every feature suite to have
the same number of tests, but important gaps should be visible and intentional.

## 9. Side-Effect Assertions

Authentication products often fail through missing or incorrect side effects,
not just wrong HTTP responses. Tests should assert side effects when they are
part of the expected behavior.

Side effects to assert when relevant:

- audit events are emitted with the correct actor, tenant, action, and outcome
- operational logs preserve diagnostic value while redacting sensitive details
- settings history records security-relevant configuration changes
- session, grant, device, CIBA, refresh-token, and factor state transitions are
  persisted correctly
- queue messages and webhook payloads keep their documented shape and signature
  behavior
- tenant-scoped records are read, written, and deleted only inside the intended
  tenant boundary
- discovery, JWKS, OpenAPI, or generated config contracts change only when the
  feature intentionally changes them

This rule is adapted from the practical testing style observed in mature
identity products: responses, events, state, and configuration must agree.

## 10. Authrim Critical Decision Matrix

| Decision area            | Primary package                            | Required technique                      | Evidence                                                           |
| ------------------------ | ------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
| Redirect URI validation  | `ar-auth`, `ar-management`                 | decision table, boundary values         | exact match, scheme mismatch, host mismatch, path/query edge cases |
| Client authentication    | `ar-token`, `ar-management`                | decision table, negative tests          | method selection, missing secret, invalid assertion                |
| PKCE validation          | `ar-auth`, `ar-token`                      | equivalence partitions, boundary values | valid verifier, wrong verifier, missing challenge                  |
| Tenant issuer resolution | `ar-discovery`, `ar-router`, `ar-lib-core` | decision table                          | single tenant, multi tenant, naked domain, subdomain               |
| CORS and CSRF            | `ar-router`, `ar-lib-core`                 | MC/DC-style decision table              | allowed origin, foreign origin, Referer fallback, missing headers  |
| JWK selection            | `ar-discovery`, `ar-lib-core`              | equivalence partitions, negative tests  | matching `kid`, wrong `kid`, retired key, algorithm mismatch       |
| Scope and consent        | `ar-auth`, `ar-management`                 | decision table                          | requested, allowed, denied, remembered consent                     |
| Session and logout       | `ar-auth`                                  | state transition testing                | active, expired, revoked, backchannel                              |
| Async flow status        | `ar-async`                                 | state transition testing                | pending, approved, denied, expired, polled                         |
| Logging redaction        | `ar-lib-core`, `ar-lib-logging`            | checklist, negative tests               | sensitive details redacted, operational evidence preserved         |

## 11. Minimum Test Quality Bar

A test is considered meaningful when it:

- validates observable behavior or a stable boundary contract
- would fail for a plausible security or protocol regression
- includes negative coverage for risky inputs
- uses deterministic fixtures
- avoids asserting only implementation details
- is named clearly enough to explain the risk it covers

Tests added only to execute lines without validating behavior should not count
toward critical decision readiness.
