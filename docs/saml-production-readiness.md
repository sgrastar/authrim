---
project: Authrim
lang: en
date: 2026-05-25
description: 'SAML production readiness status, operational behavior, and administrator surfaces.'
type: guide
tags:
  - authrim
  - saml
  - production-readiness
---

# SAML Production Readiness

Authrim includes SAML 2.0 IdP and SP support for tenant-scoped deployments. The current production-readiness work focuses on predictable metadata, signing policy, certificate lifecycle, attribute release control, logout correlation, interactive login routing, federation import, and operational visibility.

## Implemented Capabilities

- Tenant-scoped SAML provider lookup and signing key resolution.
- Stable IdP/SP metadata entity descriptors with weak ETag and `cacheDuration="PT24H"`.
- Configurable published entityID style:
  - `metadata_url`: `/saml/idp/metadata` and `/saml/sp/metadata`.
  - `role_url`: `/saml/idp` and `/saml/sp`.
- Configurable interactive login redirect policy:
  - tenant host login URL for tenant-specific SAML flows.
  - UI base URL with tenant hint when a shared Login UI entry is preferred.
- Optional generated metadata XML signatures via `SAML_METADATA_SIGNING=enabled`.
- Active, next, and backup signing certificate publication for rollover.
- Admin APIs and UI controls for recreate, publish-next, promote-next, and retire-backup rollover steps.
- Configurable default signing-certificate subject fields for newly generated local SAML certificates, including country, state/province, locality, organization, organizational unit, and common name.
- SP metadata import for ACS, SLO, signing certificates, encryption certificates, and RequestedAttribute data.
- Aggregate metadata import with search, lazy loading, `mdui:Keywords` filtering, `mdui:Logo` display, and selected provider creation.
- Provider Login UI logo URL and curated login-button icon selection for SAML/OIDC login methods.
- Metadata refresh diffing for entityID, `validUntil`, signing/encryption certificates, and SSO/SLO/ACS endpoints.
- Built-in attribute preset catalog for common academic, federation, and enterprise SaaS profiles.
- Response/assertion signing policy, AuthnRequest signature policy, SLO signature policy, and algorithm allow-list behavior.
- Optional encrypted assertion and encrypted NameID support with modern defaults and legacy algorithm opt-in.
- Persistent NameID registry behavior for strict `AllowCreate=false` handling.
- Federated identity registry and JIT linking policy for inbound SAML ACS:
  existing link, verified-email linking, JIT create, or existing-link-only modes.
- Tenant-scoped request correlation for SAML requests, LogoutRequests, ACS, SLO, artifact state, and IdP-initiated multi-SP SLO fanout.
- Audit events for SAML policy failures, metadata refresh changes, and logout fanout timeouts.

## Metadata Operations

SAML provider records can store a metadata URL and refresh status. A metadata refresh records a hash, critical field snapshots, and a diff summary. Expired metadata is persisted as an observable state and returned to administrators instead of being silently ignored.

Manual refresh endpoint:

```http
POST /api/admin/saml-providers/:id/refresh-metadata
```

The Admin UI SAML page surfaces provider metadata status, validity, expiry window, RequestedAttribute counts, release policy suggestion counts, metadata import candidates, provider logos, and icon settings.

The SAML Entity Info page surfaces local Authrim IdP/SP registration data:

- SSO, ACS, SLO, and metadata URLs.
- published IdP/SP entityIDs.
- metadata XML download.
- published certificate subject, issuer, validity, public key algorithm, signature algorithm, SHA-1 fingerprint, SHA-256 fingerprint, PEM copy, and PEM download.
- SAML metadata publication status such as validity window and cache duration.

## Signing Rollover

Signing rollover is modeled as active, next, and backup certificate slots. Operators can publish a next certificate, promote it to active, and retire the backup after SP metadata caches have aged out.

Admin endpoints:

```http
POST /api/admin/saml-providers/:id/signing-rollover/publish-next
POST /api/admin/saml-providers/:id/signing-rollover/promote-next
POST /api/admin/saml-providers/:id/signing-rollover/retire-backup
```

Local Authrim IdP/SP signing keys are managed through the SAML Entity Info page. Certificate subject changes affect newly generated certificates only. Existing federation partners may need refreshed metadata after a certificate is recreated, published as next, promoted, or retired.

## Interactive Login Redirects

When a SAML flow needs interactive login, Authrim can send the browser to either the tenant host or the shared Login UI base URL.

| Policy      | Behavior                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant host | Uses the tenant's `/login` URL. This is the default SAML behavior and lets the Login UI resolve the tenant from the request host.                                         |
| UI base URL | Uses the global Login UI `/login` with a tenant hint. This is useful when a deployment wants a common login entry before returning to tenant-specific login or discovery. |

The Admin UI preview resolves the first visible page using the current tenant discovery configuration. If the common entry is configured as WAYF-only, the preview indicates that the tenant chooser is the first page and that only the tenant dropdown is shown.

## Federated Identity Registry

Inbound SAML ACS resolution stores a stable provider subject in `linked_identities` using the
IdP entityID, NameIDFormat, and NameID. Provider policy controls whether a first login may link
to an existing verified local email, create a new JIT user, or require a pre-existing link.
Resolution failures are audited with sanitized policy metadata only, avoiding raw NameID and
assertion email values.

The Admin UI exposes these controls on SAML IdP providers:

| Setting                       | Default         | Behavior                                                                                                   |
| ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| `jitEmailLinkingPolicy`       | `email_linking` | Existing link, verified email link, then JIT create. Can be restricted to `jit_create_only` or `disabled`. |
| `allowSyntheticEmailFallback` | `false`         | Allows a non-PII synthetic local email only for legacy IdPs that cannot release email.                     |

See the private runbook for rollout, backfill, validation, and rollback steps.

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
- Browser CSP and SP compatibility can affect HTTP-POST binding tests. Some public SAML test sites apply restrictive or inconsistent `form-action` policies; use a reliable SP test target before treating a browser-side form-post block as an IdP response defect.
