---
title: 'ISO/IEC/IEEE 29119-1 General Concepts - Lightweight Test Profile'
project: Authrim
lang: en
date: 2026-05-20
status: draft
---

# ISO/IEC/IEEE 29119-1 General Concepts - Lightweight Test Profile

## 1. Purpose

This document defines the lightweight testing concepts used by Authrim. It is
aligned with the intent of ISO/IEC/IEEE 29119-1, but it is not a certification
claim or a verbatim implementation of the standard.

Authrim is an authentication and authorization platform. Testing therefore
focuses on correctness, security, interoperability, tenant isolation, and
operational reliability.

## 2. Scope

This profile applies to backend, worker, library, setup, and protocol packages.
SvelteKit UI packages are covered by separate UI and browser testing guidance
and are excluded from backend coverage targets unless explicitly stated.

In scope:

- OAuth 2.0 and OpenID Connect protocol behavior
- token issuance, validation, revocation, rotation, and introspection
- client authentication and client metadata validation
- redirect URI, issuer, origin, and tenant resolution
- authorization, consent, session, logout, and async flows
- key management, JWKS, signing, and rotation behavior
- management APIs, admin authorization, audit, logging, and setup flows
- storage adapters, Durable Objects, queue consumers, and retry behavior

Out of scope for this profile:

- visual UI layout quality
- browser accessibility checks
- marketing or documentation rendering
- third-party provider conformance beyond mocked or contracted behavior

## 3. Test Objectives

Authrim tests are designed to provide evidence that:

- security-sensitive decisions reject unsafe input by default
- protocol responses are compatible with documented OAuth/OIDC expectations
- tenant boundaries cannot be crossed through host, issuer, or request metadata
- cryptographic and key-selection behavior is deterministic and auditable
- operational failures return controlled errors and do not leak secrets
- logging and audit behavior preserves useful evidence without exposing sensitive data
- regressions are caught near the package that owns the behavior

## 4. Test Items

The primary test items are workspace packages under `packages/`, maintained integration flows under
`test/integration`, high-volume security combinations under `test/security-matrices`, generated
environment checks under `test/generated-environment`, and end-to-end flows under `test-e2e`.

Security-sensitive packages include:

- `packages/ar-auth`
- `packages/ar-token`
- `packages/ar-discovery`
- `packages/ar-router`
- `packages/ar-async`
- `packages/ar-management`
- `packages/ar-lib-core`
- `packages/ar-lib-logging`

## 5. Test Levels

| Level               | Purpose                                                                          | Primary tools                                |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| Unit                | Validate local functions, validators, decision logic, and error mapping          | Vitest                                       |
| Component           | Validate a package handler or worker boundary with mocked bindings               | Vitest                                       |
| Integration         | Validate multi-package protocol and storage behavior                             | Vitest, scripts                              |
| End-to-end          | Validate browser-visible flows and UI integration                                | Playwright                                   |
| Security-focused    | Validate misuse, malformed input, authorization boundaries, and leakage controls | Vitest, Playwright, targeted scripts         |
| Conformance-focused | Validate OAuth/OIDC-compatible behavior and public metadata                      | Vitest, external conformance where available |

## 6. Risk Categories

Risk-based testing uses the following categories:

| Category                  | Examples                                               | Expected test emphasis                           |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| Authentication bypass     | weak client auth, session confusion, mock auth leakage | decision tables, negative cases, branch coverage |
| Authorization bypass      | role checks, admin APIs, tenant isolation              | positive/negative matrix tests                   |
| Token compromise          | wrong audience, issuer, expiry, rotation, replay       | boundary tests, malformed token tests            |
| Redirect and origin abuse | redirect URI, CORS, CSRF, Referer, Origin              | decision tables, MC/DC-style condition checks    |
| Key misuse                | JWKS selection, `kid`, algorithm, rotation             | deterministic fixtures and negative cases        |
| Privacy leakage           | logs, errors, audit payloads, support data             | redaction and schema tests                       |
| Availability degradation  | Durable Object errors, queue retries, storage failures | failure injection and retry tests                |
| Interoperability drift    | public metadata, endpoints, grant behavior             | contract and discovery tests                     |

## 7. Coverage Concepts

Coverage is used as a signal, not as a substitute for test quality.

Authrim tracks:

- line coverage
- statement coverage
- branch coverage
- function coverage
- critical decision coverage for selected security decisions
- MC/DC-style evidence for high-risk boolean decisions where practical

Package-level coverage targets are set in the test process document. Critical
security decisions may require specific test design evidence even when package
coverage is already above target.

## 8. Test Basis

Test design may use the following sources:

- Authrim product specifications and architecture documents
- OAuth 2.0, OpenID Connect, JOSE, SAML, SCIM, and related protocol requirements
- package source code and public handler contracts
- threat models and security review notes
- known incident classes for authentication systems
- customer-facing behavior and operational requirements

## 9. Traceability

For lightweight operation, traceability is maintained through:

- test file names colocated with the owned behavior
- test names that state the expected behavior and risk
- decision tables for critical security logic
- package coverage reports
- pull request summaries listing affected packages and tests run

Full requirement-to-test traceability may be introduced for regulated or
enterprise-specific deliverables.

## 10. Status and Review

This profile is reviewed when:

- a new security-sensitive package is introduced
- a protocol boundary changes
- coverage targets change
- a security incident, audit finding, or conformance issue identifies a gap
- release readiness criteria change
