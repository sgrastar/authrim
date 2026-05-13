---
project: Authrim
lang: en
date: 2026-05-12
description: 'SAML production readiness status, operational behavior, and administrator surfaces.'
type: guide
tags:
  - authrim
  - saml
  - production-readiness
---

# SAML Production Readiness

Authrim includes SAML 2.0 IdP and SP support for tenant-scoped deployments. The current production-readiness work focuses on predictable metadata, signing policy, attribute release control, logout correlation, and operational visibility.

## Implemented Capabilities

- Tenant-scoped SAML provider lookup and signing key resolution.
- Stable IdP/SP metadata entity descriptors with weak ETag and `cacheDuration="PT24H"`.
- Optional generated metadata XML signatures via `SAML_METADATA_SIGNING=enabled`.
- Active, next, and backup signing certificate publication for rollover.
- Admin APIs for publish-next, promote-next, and retire-backup rollover steps.
- SP metadata import for ACS, SLO, signing certificates, encryption certificates, and RequestedAttribute data.
- Metadata refresh diffing for entityID, `validUntil`, signing/encryption certificates, and SSO/SLO/ACS endpoints.
- Built-in attribute preset catalog for common academic, federation, and enterprise SaaS profiles.
- Response/assertion signing policy, AuthnRequest signature policy, SLO signature policy, and algorithm allow-list behavior.
- Optional encrypted assertion and encrypted NameID support with modern defaults and legacy algorithm opt-in.
- Persistent NameID registry behavior for strict `AllowCreate=false` handling.
- Tenant-scoped request correlation for SAML requests, LogoutRequests, ACS, SLO, artifact state, and IdP-initiated multi-SP SLO fanout.
- Audit events for SAML policy failures, metadata refresh changes, and logout fanout timeouts.

## Metadata Operations

SAML provider records can store a metadata URL and refresh status. A metadata refresh records a hash, critical field snapshots, and a diff summary. Expired metadata is persisted as an observable state and returned to administrators instead of being silently ignored.

Manual refresh endpoint:

```http
POST /api/admin/saml-providers/:id/refresh-metadata
```

The Admin UI SAML page surfaces provider metadata status, validity, expiry window, RequestedAttribute counts, and release policy suggestion counts.

## Signing Rollover

Signing rollover is modeled as active, next, and backup certificate slots. Operators can publish a next certificate, promote it to active, and retire the backup after SP metadata caches have aged out.

Admin endpoints:

```http
POST /api/admin/saml-providers/:id/signing-rollover/publish-next
POST /api/admin/saml-providers/:id/signing-rollover/promote-next
POST /api/admin/saml-providers/:id/signing-rollover/retire-backup
```

The current Admin UI exposes promote-next and retire-backup operations. Publishing a new next certificate still requires the API because certificate source and private-key generation policy are deployment-specific.

## IdP-Initiated Multi-SP SLO

IdP-initiated multi-SP logout uses a browser-sequential fanout transaction. Each SP target is tracked as `pending`, `sent`, `succeeded`, `failed`, or `timeout`.

Fanout transaction keys are tenant-scoped:

```text
saml:logout-fanout:tenant:{tenantId}:id:{transactionId}
```

Outbound LogoutRequest correlation records include the transaction ID when they belong to a fanout. LogoutResponse validation updates the transaction and advances to the next pending SP.

A scheduled observer scans retained fanout transactions after their SAML request validity window expires, marks still-pending or sent targets as `timeout`, and emits:

```text
saml.logout_fanout.timeout
```

The observer does not retry LogoutRequests. Retry behavior remains a deployment decision because some legacy SPs treat repeated SLO messages poorly.

## Current Limits

- Active SAML sessions are not migrated during disaster recovery failover.
- Transient SAML state is short-lived and treated as re-authentication state, not DR state.
- Metadata refresh scheduling can reuse the same refresh core, but automatic URL polling policy is deployment-specific.
- Metadata signing uses the active SAML signing key when enabled; a dedicated metadata signing key can be added later if required.
- Real publisher metadata samples are tracked privately unless redistribution is permitted.
