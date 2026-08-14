---
title: 'Security Regression Bank'
project: Authrim
lang: en
date: 2026-05-20
status: draft
---

# Security Regression Bank

This document tracks regression patterns that Authrim should keep converting
into automated tests. It is intentionally practical: each item should become a
unit, component, integration, contract, or browser test when the related code is
touched.

## 1. Redirect, Origin, and Host Boundary Regressions

| Pattern                                    | Expected protection                                | Preferred test level |
| ------------------------------------------ | -------------------------------------------------- | -------------------- |
| lookalike redirect URI                     | exact registered redirect URI match is required    | package/component    |
| same host with wrong scheme                | reject unless explicitly registered                | package/component    |
| query or fragment confusion                | compare the intended registered URI components     | package/component    |
| spoofed `X-Forwarded-Host`                 | router overwrites untrusted forwarded host hints   | router/component     |
| foreign `Origin` on state-changing request | reject with controlled CSRF error                  | router/component     |
| missing `Origin` with invalid `Referer`    | reject with controlled CSRF error                  | router/component     |
| UI proxy state-changing request            | rewrite `Origin` and `Referer` to target UI origin | router/component     |

## 2. Token, Key, and Claim Regressions

| Pattern                          | Expected protection                             | Preferred test level |
| -------------------------------- | ----------------------------------------------- | -------------------- |
| expired token accepted           | reject based on deterministic clock             | package/component    |
| wrong issuer accepted            | reject and avoid tenant fallback confusion      | package/component    |
| wrong audience accepted          | reject token or grant                           | package/component    |
| `kid` mismatch accepted          | reject or refresh JWKS according to policy      | package/component    |
| unexpected `alg` accepted        | reject outside allowlist                        | package/component    |
| malformed JWT payload accepted   | reject with controlled error                    | package/component    |
| stale remote JWKS after rotation | refresh or fail closed according to policy      | integration          |
| tenant cache collision for keys  | isolate key lookup by issuer or tenant boundary | integration          |

## 3. Authentication and Session Regressions

| Pattern                              | Expected protection                           | Preferred test level  |
| ------------------------------------ | --------------------------------------------- | --------------------- |
| stale login challenge reused         | reject or restart flow                        | component/integration |
| challenge principal changed mid-flow | reject or require reauthentication            | integration           |
| consent bypassed after scope change  | require consent for new scope                 | integration           |
| refresh token family replay          | revoke or reject according to rotation policy | package/component     |
| backchannel logout not propagated    | session state and event evidence are updated  | integration           |
| passkey binding replay               | reject duplicate or stale binding attempts    | component/browser     |

## 4. Tenant, Topology, and Storage Regressions

| Pattern                              | Expected protection                                  | Preferred test level   |
| ------------------------------------ | ---------------------------------------------------- | ---------------------- |
| cross-tenant client lookup           | reject or ignore client outside current authority    | integration            |
| issuer differs by topology           | issue metadata and challenges with correct issuer    | integration            |
| naked-domain primary authority drift | preserve intended issuer and routing behavior        | integration            |
| tenant-specific D1 slot mismatch     | read/write only through the selected runtime slot    | integration            |
| external database fallback confusion | fail closed or use configured external path only     | integration            |
| generated env missing binding        | validation catches the missing binding before deploy | environment validation |

## 5. Logging, Audit, and Queue Regressions

| Pattern                                      | Expected protection                             | Preferred test level |
| -------------------------------------------- | ----------------------------------------------- | -------------------- |
| sensitive detail emitted in operational log  | redact or chunk according to policy             | package/component    |
| audit event missing for security action      | emit expected event with tenant, actor, outcome | package/component    |
| settings history missing after config change | persist before/after or relevant metadata       | package/component    |
| queue payload shape drift                    | producer and consumer contract tests fail       | package/component    |
| webhook signature mismatch                   | reject or mark failed delivery                  | integration          |
| DLQ path loses diagnostic metadata           | preserve safe diagnostic fields                 | package/component    |

## 6. Failure Injection Regressions

| Pattern                 | Expected protection                                     | Preferred test level  |
| ----------------------- | ------------------------------------------------------- | --------------------- |
| D1 unavailable          | controlled error, no unsafe allow                       | component/integration |
| KV stale or missing     | fail closed for security decisions                      | component/integration |
| Durable Object timeout  | controlled error and observable diagnostic evidence     | component             |
| queue send failure      | retry, DLQ, or controlled failure according to policy   | package/component     |
| external IdP timeout    | controlled bridge error, no partial session             | integration           |
| JWKS fetch failure      | fail closed or use valid cached key according to policy | package/component     |
| signing key unavailable | reject issuance, do not emit unsigned token             | package/component     |

## 7. Maintenance Rules

- Add a new bank item when a security review, bug, customer concern, or test
  gap reveals a reusable regression pattern.
- Prefer turning bank items into tests near the owning package first.
- Keep focused cross-package flows under `test/integration`; use `test/security-matrices` for
  high-volume protocol, topology, and state-transition combinations.
- Keep browser-visible behavior under Playwright or UI-specific suites.
- Remove or mark an item as covered only when the automated test is stable and
  named clearly enough to explain the risk.
