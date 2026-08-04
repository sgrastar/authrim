---
title: 'Test Improvement Actions'
project: Authrim
lang: en
date: 2026-05-20
status: draft
---

# Test Improvement Actions

This document turns the broader testing concerns into concrete Authrim actions.
Some items are automated tests to add; others are habits to apply during future
changes.

## 1. Immediate Actions

| Area                     | Concrete action                                                                  | Where                                                     |
| ------------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Security regression bank | Convert high-risk patterns into tests when touching the related code             | `docs/testing/security-regression-bank.md`, package tests |
| Release confidence       | Use the checklist to choose package, integration, environment, or browser checks | `docs/testing/release-confidence-checklist.md`            |
| Change habits            | Apply the testing rules for every security-sensitive change                      | `AGENTS.md`, this document                                |
| Coverage discipline      | Treat coverage as a working signal and review uncovered critical paths           | package coverage reports                                  |
| Runtime topology         | Keep topology/storage matrices broader than tenant-only behavior                 | `test/integration`, `test/environment-validation`         |

## 2. Tests to Add When Related Code Is Touched

| Concern                     | Add tests for                                                                                            | Preferred location                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Redirect and origin abuse   | lookalike redirect URIs, wrong scheme, spoofed forwarded host, foreign origin, missing/invalid Referer   | `ar-auth`, `ar-router`, `ar-lib-core`                       |
| Token and key validation    | wrong issuer/audience, expired token, wrong `kid`, unexpected `alg`, malformed JWT payload, JWKS refresh | `ar-token`, `ar-discovery`, `ar-lib-core`                   |
| Client authentication       | missing secret, invalid assertion, unsupported auth method, tenant/client mismatch                       | `ar-token`, `ar-management`                                 |
| Session lifecycle           | stale challenge, principal change, replayed refresh family, revoked session, backchannel logout          | `ar-auth`, `test/integration`                               |
| Async lifecycle             | device/CIBA pending, approved, denied, expired, replayed, polled too fast                                | `ar-async`, `ar-token`                                      |
| Runtime storage topology    | single/multi-shard, mixed placement, external adapter, missing binding, wrong owner, fallback confusion | `setup`, `ar-lib-core`, `ar-management`, `test/integration` |
| Logging and audit           | redaction, audit event presence, settings history, queue payload, DLQ metadata                           | `ar-lib-core`, `ar-lib-logging`, `ar-management`            |
| Webhooks and delivery       | payload shape, signature, retry, failed delivery, fake endpoint assertions                               | `ar-management`, `ar-lib-core`                              |
| External IdP and federation | upstream timeout, callback mismatch, JIT/linking failure, backchannel logout                             | `ar-bridge`, `test/integration`                             |
| UI-visible flows            | login, consent, passkey/WebAuthn, admin setting changes, accessibility                                   | UI package tests, Playwright                                |

## 3. Habits to Apply During Implementation

For each security-sensitive task:

1. Identify the owning package and the nearest test suite.
2. Identify whether the behavior is a critical decision, state machine,
   contract, topology matrix, or side-effect behavior.
3. Add a positive case and a negative case where applicable.
4. Add a regression test for reproduced bugs when practical.
5. Assert side effects when the behavior changes state outside the response.
6. Run targeted package tests first.
7. Run coverage for security-sensitive packages when the change affects auth,
   token, policy, topology, logging, or audit behavior.
8. Escalate to integration, environment validation, or browser tests only when
   the risk crosses those boundaries.
9. Record residual risk in the change summary when a meaningful test cannot be
   added.

## 4. Failure Injection Backlog

Add targeted failure-injection tests for these paths as the implementations are
touched:

| Failure                 | Expected posture                                        |
| ----------------------- | ------------------------------------------------------- |
| D1 unavailable          | controlled error, no unsafe allow                       |
| KV stale or missing     | fail closed for security decisions                      |
| R2 unavailable          | preserve response safety and diagnostics                |
| Durable Object timeout  | controlled error and observable diagnostic evidence     |
| queue send failure      | retry, DLQ, or controlled failure according to policy   |
| external IdP timeout    | controlled bridge error, no partial session             |
| JWKS fetch failure      | fail closed or use valid cached key according to policy |
| signing key unavailable | reject issuance, do not emit unsigned token             |

## 5. Contract Test Backlog

Prefer narrow contract tests for stable external contracts:

| Contract                            | Suggested assertion                                              |
| ----------------------------------- | ---------------------------------------------------------------- |
| OIDC discovery metadata             | schema shape, issuer, endpoint URLs, feature-dependent fields    |
| OAuth authorization server metadata | supported grants, auth methods, PAR/JAR/JARM flags               |
| JWKS                                | public-only key shape, `kid`, `alg`, active/retired key behavior |
| setup output                        | generated env, bindings, routes, runtime profile selection       |
| webhook payload                     | stable event type, tenant, actor, signature, timestamp           |
| audit event schema                  | actor, tenant, action, outcome, redaction                        |
| queue payload schema                | producer/consumer compatibility without accidental drift         |

## 6. When Not to Add a Test

Do not add a test when it only:

- repeats an implementation detail with no stable contract
- executes a line without checking behavior
- snapshots volatile data that changes every run
- depends on real external network services
- requires a browser when a local integration test proves the same risk

Document the reason if the untested behavior is still security-sensitive.
