---
project: Authrim
lang: en
date: 2026-08-15
description: 'Configure tenant-scoped inbound SCIM provisioning and identity mapping.'
type: guide
tags:
  - scim
  - provisioning
  - field-mapping
---

# SCIM Inbound Provisioning

Authrim accepts SCIM 2.0 inbound provisioning for Users, Groups, and Bulk. Outbound SCIM
provisioning is outside the current product scope.

Inbound SCIM is disabled for each tenant until an active Mapping Set is selected and the tenant
setting is enabled. User writes fail closed if the Mapping Set is missing, inactive, or cannot
produce the required Authrim email field.

## 1. Define canonical fields

Create any required custom claim schema fields in Admin UI before building the Mapping Set. Field
keys use lowercase snake_case. For the SCIM enterprise extension, use fields such as:

- `employee_number` (string)
- `cost_center` (string)
- `organization` (string)
- `division` (string)
- `department` (string)
- `manager` (string)

Do not create `employeeNumber` or `costCenter` as canonical field keys. The SCIM adapter reads the
camelCase protocol attributes and the Mapping Set explicitly maps them to snake_case storage keys.

## 2. Create and activate a SCIM source profile

Open **Source & Destination**, select **SCIM**, and choose **Create from template**. Authrim
provides these starting points:

- **Minimal SCIM User** for account status, display name, and primary email.
- **SCIM Core User** for the supported core User attributes.
- **SCIM Enterprise User** for core attributes plus workforce extension attributes.

Use the template, adjust its attribute list when necessary, then save the source profile. The current
simplified Admin workflow saves, reviews, and activates it in one operation. Templates are starting
points and do not appear in the Flow Editor until a tenant saves and activates a profile.

`Required` and `Mapping required` are separate controls. `Required` describes whether the inbound
source value is required. `Mapping required` requires the field to have an outgoing Mapping Set edge
when the mapping version is saved. The SCIM templates mark `userName` as mapping-required by default.

## 3. Create the inbound Mapping Set

In **Field Mapping**, create a Mapping Set and select the active SCIM source profile.
Map only the attributes the tenant accepts. A recommended baseline is:

| SCIM source                     | Authrim destination  | Notes                                                                                     |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `emails.value`                  | `email`              | Required runtime output; `userName` may be used instead when it contains an email address |
| `userName`                      | `preferred_username` | Required by the SCIM User schema                                                          |
| `externalId`                    | `external_id`        | Recommended stable source-system identifier                                               |
| `active`                        | `active`             | Enables provisioning deactivation                                                         |
| `displayName`                   | `name`               | Display name                                                                              |
| `name.givenName`                | `given_name`         | Optional                                                                                  |
| `name.familyName`               | `family_name`        | Optional                                                                                  |
| `name.middleName`               | `middle_name`        | Optional                                                                                  |
| `nickName`                      | `nickname`           | Optional                                                                                  |
| `profileUrl`                    | `profile`            | Optional                                                                                  |
| `preferredLanguage` or `locale` | `locale`             | Choose one source or add precedence rules                                                 |
| `timezone`                      | `zoneinfo`           | Optional                                                                                  |
| `phoneNumbers.value`            | `phone_number`       | Primary value selected by the adapter                                                     |
| `addresses.primary`             | `address`            | JSON value                                                                                |
| `enterprise.employeeNumber`     | `employee_number`    | Explicit camelCase-to-snake_case mapping                                                  |
| `enterprise.costCenter`         | `cost_center`        | Explicit camelCase-to-snake_case mapping                                                  |
| `enterprise.organization`       | `organization`       | Optional                                                                                  |
| `enterprise.division`           | `division`           | Optional                                                                                  |
| `enterprise.department`         | `department`         | Optional                                                                                  |
| `enterprise.manager.value`      | `manager_id`         | Optional                                                                                  |

Within a tenant, `userName` is the SCIM login identifier and is unique without regard to letter
case. It may be a conventional login name, an upstream identifier, or an email address. Authrim
stores `externalId` as the source system's correlation identifier but does not require it to be
unique; multiple source records may therefore use the same `externalId` when the upstream system
allows that.

Review, compile, and activate the Mapping Set. Activation for a SCIM source is registered with the
tenant-scoped `scim` / `receiver` runtime binding.

## 4. Enable the tenant

Open **SCIM Tokens** in Admin UI and configure **Inbound provisioning**:

1. Select the active inbound Mapping Set.
2. Enable the required resource endpoints: Users, Groups, and/or Bulk.
3. Set the Bulk maximum operation count and payload size.
4. Save the settings, then enable inbound SCIM provisioning.
5. Create a tenant-bound SCIM token and store the displayed token securely.

The SCIM discovery endpoint publishes the configured Bulk support and limits.

## 5. Platform security settings

Authentication abuse controls remain deployment settings rather than tenant-admin settings:

| Variable                        | Default | Purpose                                                                           |
| ------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `ENABLE_SCIM_AUTH_RATE_LIMIT`   | `true`  | Disable only in isolated tests                                                    |
| `SCIM_AUTH_MAX_FAILED_ATTEMPTS` | `5`     | Failed bearer-token attempts before lockout                                       |
| `SCIM_AUTH_WINDOW_SECONDS`      | `300`   | Failure counting window                                                           |
| `SCIM_AUTH_LOCKOUT_SECONDS`     | `900`   | Lockout duration after the threshold                                              |
| `SCIM_AUTH_FAILURE_DELAY_MS`    | `200`   | Initial failed-authentication delay; exponential backoff is capped at two seconds |

General API rate limits and Cloudflare platform protections also remain deployment-controlled.

## 6. Identity assurance (IAL)

A provisioning client can assert how well a person's identity was proofed with Authrim's SCIM
extension `urn:authrim:params:scim:schemas:extension:assurance:1.0:User` (listed in `/Schemas`
and `/ResourceTypes`, optional):

```json
{
  "schemas": [
    "urn:ietf:params:scim:schemas:core:2.0:User",
    "urn:authrim:params:scim:schemas:extension:assurance:1.0:User"
  ],
  "userName": "taro",
  "urn:authrim:params:scim:schemas:extension:assurance:1.0:User": {
    "ial": "IAL2",
    "verifiedAt": "2026-09-01T09:00:00+09:00",
    "expiresAt": "2027-09-01T00:00:00Z"
  }
}
```

- `ial` is `IAL1`, `IAL2` or `IAL3`; `verifiedAt` (a date-time with a time zone, not in the
  future) is required; `expiresAt` is optional and may already be past.
- The claim is recorded as evidence of the SCIM token that sent it
  (`evidence_type = scim`, `issuer_ref = scim:<token reference>`). Each token replaces its own
  claim and never touches another source's evidence (another token, an administrator, the tenant
  default). The person's effective IAL is the highest of the evidence in force.
- A PUT states the whole user: a PUT **without** the extension withdraws that token's claim. A
  PATCH keeps the claim unless it changes it, through the extension's paths
  (`urn:...:assurance:1.0:User:ial`, `:verifiedAt`, `:expiresAt`) or by removing the extension.
- The extension is returned by `GET /Users/{id}` only when named in `attributes`, and shows the
  claim of the token that asks.
- Dates and times are checked as what they say: a day that does not exist (February 30, February 29
  of a year that is not a leap year, month 13) or a time that does not (hour 24, minute 60) is
  refused with 400, never rolled over into the next month.

How a claim is kept:

- The evidence is identified by its content alone: tenant, user, token, `ial`, `verifiedAt` and
  `expiresAt`, the same whether the claim is made when the user is created (POST) or later (PUT,
  PATCH). The rule: **identical content never re-activates a revoked claim, whoever revoked it**
  (an administrator, or the client itself by leaving the extension out of a PUT or replacing the
  claim by another). To establish a claim again after it was revoked, the client sends a new
  verification: a different `verifiedAt`, `ial` or `expiresAt`. Sending a claim again that is
  still in force changes nothing, and sending one that was revoked changes nothing (the response
  is still success).
- A PATCH that does not change the extension does not write evidence at all. A PATCH that changes
  it records the new claim by the rule above and revokes the token's previous claim in the same
  step.
- Evidence changes only after the user itself was written. A PUT, PATCH or Bulk operation that
  fails (for example `409` because the `userName` is taken) neither records nor revokes any
  evidence. When the user was written and the evidence step then fails, the request answers `500`
  (never success, and never "no claim"); send the same request again, as both the user write and
  the evidence are safe to repeat. A client that uses `If-Match` must read the user again first,
  as the user write changed its version.
- The version of the user (`ETag`, `meta.version`) moves whenever evidence of the user is recorded,
  put in force, revoked or replaced, by anyone. A conditional `GET` made before an administrator
  revoked the claim is therefore answered `200`, and an `If-Match` with the old version is refused
  with `412`.
- A user created without the extension gets the tenant's default IAL (`assurance.default_ial`) as
  tenant-policy evidence when it is IAL2 or IAL3. When that setting cannot be read, the user is not
  created and the request returns a retryable 503.

### Ceiling on what SCIM may assert (`assurance.scim_max_ial`)

The tenant setting `assurance.scim_max_ial` (a whole number from 1 to 3, deployment default
`SCIM_MAX_IAL`) is the highest IAL a SCIM token may assert through the extension. **It is 1 until
the tenant raises it**, so a SCIM source can assert IAL2 or IAL3 only after an administrator allows
it.

- It applies to every place the extension's `ial` is accepted: POST, PUT, PATCH and Bulk (each
  operation on its own). A claim above the ceiling is refused with `400 invalidValue`, naming the
  extension and the ceiling, **before anything is written**: the user is not created or updated and
  no evidence changes.
- It applies whether or not assurance levels (`assurance.enabled`) are on, like the other
  per-source rules: the extension itself is accepted regardless, so its limit is too.
- It limits SCIM-asserted evidence only. It does not limit evidence an administrator records, the
  default IAL for accounts the organisation creates (`assurance.default_ial`), or a CSV import
  (an administrator's action).
- Lowering it does not revoke evidence already recorded above it. A user whose token-held claim is
  above the lowered ceiling can still be updated: a PATCH that leaves the claim alone, and a PUT
  that sends the same claim, are not new assertions. A claim sent anew above the ceiling (a
  different level or verification) is refused.
- A request that asserts no claim does not read the setting, and neither does a PATCH that leaves
  the claim as it was. When the tenant setting cannot be read (or holds something that is not 1
  to 3), a request that asserts a claim fails with a retryable `503` and writes nothing; "no
  ceiling" is never assumed. An invalid deployment value in `SCIM_MAX_IAL` (not a whole number
  from 1 to 3) is ignored and the default (IAL1) applies: it can only leave the ceiling at its
  most restrictive value, never raise it.
- A creation retried with the same `Idempotency-Key` after the ceiling was lowered is rejected
  (`400`) when its claim is above the new ceiling, before the earlier creation is looked up. The
  client should not retry the creation, and what it does depends on how the first request ended:
  after a `201`, `GET` the user (it exists with the claim recorded then); after a `202`, follow
  the Operations URL that was returned (the user is not readable until publication completes);
  after a `500` or `503`, do not assume the account exists, and check the state of the
  operation instead.

The default is the constant `DEFAULT_SCIM_MAX_IAL` in
`packages/ar-lib-core/src/types/settings/assurance-levels.ts`.

## Current boundaries

- This guide covers inbound SCIM only; Authrim does not send outbound SCIM changes.
- Mapping Sets currently transform User attributes. Group resources map directly to Authrim roles and
  memberships.
- SCIM valuePath filters are rejected. Simple `eq`, `co`, `sw`, and `ew` filters are supported.
- Deactivated users remain readable and can be updated or reactivated. A deleted user returns 404.
- Malformed JSON, missing resource schemas, invalid attribute types, and invalid email values return
  SCIM 400 errors. `count=0` returns an empty page while preserving `totalResults`.
- User list queries currently aggregate a bounded cross-shard result set before filtering and
  pagination; large-directory scalability requires further work before high-volume list testing.
- User `groups` readback reports direct Authrim role memberships. Nested or indirect group
  memberships are not currently modeled.
