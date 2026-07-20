---
project: Authrim
lang: en
date: 2026-07-20
description: 'Login Flow Consent Gate configuration, rollout, evidence, and rollback.'
type: operations
tags:
  - authrim
  - consent
  - oidc
  - saml
  - flow
---

# Login Flow Consent Gates

Authrim can evaluate Legal document acceptance, OIDC scope/claim release, and SAML attribute
release in the shared Login Flow. The protocol result is not taken from browser input. A completed
Gate creates a short-lived, single-use receipt bound to the tenant, subject, target, Flow version,
Flow node, and original OIDC or SAML request.

## Enablement and rollback

The protocol integration is opt-in. Configure either the tenant setting
`feature.flow_protocol_consent_gates.enabled` or the deployment fallback
`ENABLE_FLOW_PROTOCOL_CONSENT_GATES=true`. A tenant setting of `false` overrides a deployment-wide
`true`, so rollback does not require a deployment or schema downgrade. Feature values are cached for
the configured feature-flag cache TTL (180 seconds by default).

Use `feature.flow_protocol_consent_shadow.enabled` or
`ENABLE_FLOW_PROTOCOL_CONSENT_SHADOW=true` during observation. Shadow events contain only Gate kind,
Flow/legacy action, and a stable reason code; requested claim or attribute values are not logged.

Flow UI and protocol receipt enforcement deliberately share one switch. Enabling UI without the
consumer would create a second legacy challenge, while enabling the consumer without UI cannot
produce a receipt. Keeping them atomic makes rollback safe: disable the tenant flag and new requests
return to the legacy OIDC consent page or built-in SAML attribute form. Interactions already showing
a Gate receive `AR_FLOW_PROTOCOL_CONSENT_GATE_DISABLED` and must restart.

## Rollout sequence

1. Apply the core and external-database migrations.
2. Create and publish statement versions, add them to a Policy, configure target bindings, and
   publish the Login Flow.
3. Use the effective-policy preview to verify resolution source, versions, defaults, and targets.
4. Enable shadow logging and monitor `shadow_mismatch` reason codes.
5. Enable protocol Consent Gates for an internal tenant.
6. Monitor `receipt_validation_failure`, `double_challenge_avoided`, and `protocol_error` events.
7. Expand tenant by tenant. Roll back by setting the tenant flag to `false`.

## Storage responsibilities

- `consent_records` stores minimized evidence, Flow context, and receipt correlation. It must not
  contain raw claim or attribute values.
- `document_acknowledgments_current` is the Client-independent current state for a Legal
  statement/version. Withdrawing it affects every Client or SP using that same version.
- `oauth_client_consents` is the current OIDC scope/claim release grant for one Client.
- `attribute_release_consents` is the current SAML attribute release grant for one SP and source
  attribute-set hash.
- `consent_gate_decision_receipts` is short-lived continuation authority and is consumed once by the
  protocol handler.

Consent Gate repositories use the tenant-aware storage resolver. The supported matrix is shared D1,
tenant-specific D1, deployment-wide PostgreSQL/MySQL, and tenant-isolated external databases. A
tenant-isolated deployment fails closed when its registry entry, binding, or connection reference
cannot be resolved; it never falls back to the shared database.

Legal, OIDC, and SAML Gate writes use an all-or-nothing database batch. This is required for D1,
whose callback-style adapter transaction cannot roll back statements that have already executed.
Evidence, the current-state projection, and the ready receipt therefore cannot be committed as
independent partial results.

## Configuration sequence

1. Create a Consent Statement and publish the intended version.
2. Add one or more Statements to a Consent Policy and choose required/optional behavior.
3. Bind the Policy to a tenant default, OIDC Client ID, or SAML SP EntityID.
4. Add the matching Gate kind to the shared Login Flow and publish/assign that Flow.
5. Preview the effective Policy before rollout. The preview shows its resolution source, statement
   versions, defaults, and affected targets.

The Flow editor rejects a Gate whose protocol branch or completion block is incompatible. At
protocol continuation, Authrim independently re-derives mandatory `openid`/essential claims and
required SAML attributes; a malformed receipt cannot downgrade them to optional.

For OIDC, the effective release set is derived from the authorization request, Client release
policy, and the active identity-mapping binding. Claim names produced by the mapping are displayed
as required and cannot be deselected: filtering them only in the consent UI would otherwise disagree
with token mapping. `once`, `every_time`, and `until_attributes_change` come from the Client release
policy. The mapping snapshot participates in the release-set hash used by
`until_attributes_change`.

For SAML, `attributeReleaseConfirmation.valueDisplay` is the authoritative display policy:

- `names` (default) exposes attribute names and value counts only.
- `masked_values` exposes masked display strings.
- `full_values` exposes full values only when explicitly configured by the administrator.

Displayed values may exist in the short-lived stored request and Flow interaction context so the
screen can be rendered, but are never copied into consent evidence, decision receipts, audit logs,
or metrics. Required attributes remain selected and disabled in every display mode.

## User withdrawal

The Account Page separates document acceptance from service release grants. Withdrawal requires a
recent authentication and appends minimized withdrawal evidence in the same atomic batch that
changes the current grant.

- Withdrawing a document acceptance applies globally to every Client and SP using the same
  statement/version.
- Withdrawing an OIDC release removes the current grant for that Client and invalidates its consent
  cache entry.
- Withdrawing a SAML release revokes current grants for that SP.

Historical evidence remains immutable. A later request challenges again when its current-state
projection or release grant is absent, withdrawn, revoked, expired, or no longer covers the required
release set.

## Legacy compatibility

The legacy OIDC consent route and built-in SAML attribute form remain as rollback paths during the
pre-1.0 rollout. They are deprecated for tenants that enable Flow protocol Consent Gates. Removal
must occur no earlier than the first minor release after all supported deployment profiles have used
the new path for one full release cycle; the removal release must be called out in release notes.
