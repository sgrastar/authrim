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
