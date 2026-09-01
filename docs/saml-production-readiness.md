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
- Provider Login UI logo URL and curated login-button icon selection for SAML/OIDC authentication methods.
- Automatic and manual metadata refresh for URL-backed IdPs, SPs, and federation aggregates.
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

SAML provider records can store a metadata URL, refresh policy, and operational status. URL-backed
providers default to automatic polling every six hours. Administrators can switch each provider to
manual mode, choose a supported interval, or request an immediate refresh regardless of mode.

The `ar-saml` Worker runs a bounded five-minute scheduler that selects only due sources. HTTP ETag and
Last-Modified validators avoid reprocessing unchanged documents. Successful refreshes record a hash,
critical field snapshots, and a diff summary. Failures use bounded exponential retry and retain the
last known-good provider configuration. Expired metadata or an all-expired certificate set suspends
the provider from runtime use. A later valid automatic refresh restores only providers suspended by
metadata automation; an operator-disabled provider remains disabled. Unexpected entityID changes are
recorded for manual approval and are not activated automatically.

Manual refresh endpoint:

```http
POST /api/admin/saml-providers/:id/refresh-metadata
```

Federation aggregate manual refresh endpoint:

```http
POST /api/admin/saml-federation-sources/:id/refresh-metadata
```

## Federation Metadata Sources

A federation source is a signed aggregate metadata publisher plus its trust anchors and verification
policy. Its role is broader than importing many independent XML files: Authrim fetches and verifies the
aggregate once, records the validated document and entity inventory, then reconciles the already
activated IdP/SP providers linked to that source.

Each valid aggregate snapshot also replaces the source's verified runtime directory. The safe default
is `inventory_only`: new entities are searchable but cannot participate in authentication. An operator
can opt a source into `automatic` runtime resolution separately for upstream IdPs and downstream SPs.
Each enabled role requires an explicit Field Mapping Set. Explicitly configured providers always win;
if multiple automatic sources expose the same entityID at the same highest priority, resolution fails
closed.

Automatic sources may restrict entities by Registration Authority and Entity Category. Category rules
support allow/deny decisions and can select a built-in SP attribute-release preset. Deny rules take
precedence and the default decision is configurable; the Admin UI defaults it to deny. Authrim reads
these values only from their standard EntityDescriptor `Extensions` locations. Entity Category
Support is retained for inventory display but is never treated as Entity Category membership.

When a valid refresh adds an entity, it is immediately available to an opted-in runtime source. When
the latest valid snapshot removes an entity, runtime resolution stops immediately because older
snapshots are not consulted. Stopping a trust source removes it from resolution without deleting its
history; deleting the source removes its runtime rows and metadata history. Separately, explicitly
created providers retain the existing two-snapshot missing-entity grace period before being disabled.
Invalid signatures, expired aggregates, transport failures, and entityID changes never replace the
last known-good configuration.

Polling snapshots use an internal document class isolated from documents registered through the
Management API. Per source, Authrim retains the latest 8 polling documents, 128 polling validation
events, and 64 refresh jobs; runtime rows and entity summaries are pruned with their owning snapshot.
Automatic refresh reconciles at most 25 explicit provider rows per source invocation and stores a
durable continuation cursor in the refresh job history. The source refresh lease is revalidated and
extended immediately before those provider writes, so a superseded refresh cannot publish stale
provider configuration.

Federation trust URL patterns restrict which publisher URLs a trust profile may validate. The exact
metadata source URL is stored separately and is the address polled by Authrim. Automatic polling is on
by default; manual mode retains the source and trust relationship while requiring an administrator to
request refreshes.

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
- Metadata signing uses the active SAML signing key when enabled; a dedicated metadata signing key can be added later if required.
- Real publisher metadata samples are tracked privately unless redistribution is permitted.
- Browser CSP and SP compatibility can affect HTTP-POST binding tests. Some public SAML test sites apply restrictive or inconsistent `form-action` policies; use a reliable SP test target before treating a browser-side form-post block as an IdP response defect.
