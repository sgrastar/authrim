---
project: Authrim
lang: en
date: 2026-01-16
description: "Comprehensive documentation for Authrim's access control system, covering RBAC, ABAC, and ReBAC models."
type: architecture
tags:
  - authrim
  - rebac
  - rbac
  - access-control
---

# Access Control Architecture

Comprehensive documentation for Authrim's access control system, covering RBAC, ABAC, and ReBAC models.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [RBAC (Role-Based Access Control)](#rbac-role-based-access-control)
4. [ABAC (Attribute-Based Access Control)](#abac-attribute-based-access-control)
5. [ReBAC (Relationship-Based Access Control)](#rebac-relationship-based-access-control)
6. [Unified Check Service](#unified-check-service)
7. [Feature Flags](#feature-flags)
8. [API Reference](#api-reference)
9. [Database Schema](#database-schema)
10. [Usage Examples](#usage-examples)
11. [Best Practices](#best-practices)
12. [Comparison Matrix](#comparison-matrix)

---

## Overview

Authrim implements a **three-tier unified access control system** that combines:

| Model     | Primary Use Case                            | Complexity | Performance          |
| --------- | ------------------------------------------- | ---------- | -------------------- |
| **RBAC**  | Team structures, administrative hierarchies | Low        | O(1) role lookup     |
| **ABAC**  | Compliance rules, attribute-based policies  | Medium     | O(n) attribute scan  |
| **ReBAC** | Resource hierarchies, sharing models        | High       | O(d) depth traversal |

All three models are evaluated through a **Unified Check Service** in priority order:

```
ID-Level → RBAC → ReBAC → ABAC/Computed
```

---

## Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Check API Request                          │
│  POST /api/check { subject_id, permission, resource_context? }     │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Unified Check Service                           │
│  packages/ar-lib-core/src/services/unified-check-service.ts        │
└─────────────────────────────────────────────────────────────────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ ID-Level │   │   RBAC   │   │  ReBAC   │   │   ABAC   │
    │  Check   │   │  Check   │   │  Check   │   │  Check   │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
          │              │              │              │
          ▼              ▼              ▼              ▼
    ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
    │ resource │   │  roles   │   │relation- │   │ verified │
    │permissions│  │role_assign│  │  ships   │   │attributes│
    │  (D1)    │   │  (D1)    │   │  (D1)    │   │  (D1)    │
    └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### Key Files

| Component     | Location                                                     |
| ------------- | ------------------------------------------------------------ |
| Policy Types  | `packages/ar-lib-policy/src/types.ts`                        |
| Policy Engine | `packages/ar-lib-policy/src/engine.ts`                       |
| Role Checker  | `packages/ar-lib-policy/src/role-checker.ts`                 |
| Feature Flags | `packages/ar-lib-policy/src/feature-flags.ts`                |
| ReBAC Types   | `packages/ar-lib-core/src/rebac/types.ts`                    |
| ReBAC Service | `packages/ar-lib-core/src/rebac/rebac-service.ts`            |
| Unified Check | `packages/ar-lib-core/src/services/unified-check-service.ts` |
| Check API     | `packages/ar-policy/src/routes/check.ts`                     |

---

## RBAC (Role-Based Access Control)

### Core Concepts

RBAC provides hierarchical role-based access decisions with scoped role support.

#### Admin roles (Admin console and Admin API)

The people who run Authrim use a separate set of roles, stored in `DB_ADMIN` (`admin_roles`) and
unrelated to the roles of the service's own users below. They are defined once, in
`packages/ar-lib-core/src/constants/admin-roles.ts`, and the names start with the reserved prefix
`ar_`: a custom Admin role cannot be created with a name that starts with it.

| Role              | Level | Held through                      | What it is                                                                                                             |
| ----------------- | ----- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ar_super_admin`  | 100   | a global assignment only          | Every tenant and the platform. The only role that skips role checks.                                                   |
| `ar_tenant_admin` | 80    | a tenant (or a global) assignment | One tenant: settings, apps, users, support operations, ReBAC, IP allow lists, and the admins and roles of that tenant. |
| `ar_support`      | 40    | a tenant assignment               | Looks up users, unlocks accounts, ends sessions, asks for support operations (cannot approve or run them).             |
| `ar_viewer`       | 20    | a tenant assignment               | Reads; sees no secrets (client secrets, webhook payloads, full email recipients).                                      |

- `ar_tenant_admin` is never given `admin:*`: it holds the tenant's namespaces one by one, and none
  of the platform-wide ones (control plane, database connections and routing, tenants and their
  domains, backups, platform logging, break-glass).
- A role can only be given to an account from below the giver's own level, so an `ar_tenant_admin`
  gives `ar_support` and `ar_viewer`, and only an `ar_super_admin` adds another tenant admin.
- Each tenant keeps at least one active `ar_tenant_admin` without an expiry: an operation that would
  take the last one away answers `409 last_tenant_admin`.
- The seed in the role migration (source `054_admin_roles_ar_prefix.sql`, shipped in the 0.5.0
  Admin D1 release delta) is kept equal to the definition by a test.

#### Provisioning automation (a machine principal without `admin:*`)

Creating and deleting tenants (and cancelling a failed deletion) takes the global `ar_super_admin` role, or, for a machine principal,
`admin:*`. A dedicated automation principal can instead hold two narrower permissions. They are
ordinary permissions: `*`, `admin:*` and `admin:tenants:*` carry them, no built-in role lists them,
and a super admin can hand them to a principal through the machine access API (which asks for the
`machine.permission.grant` step-up).

| Permission                | Opens (exactly these method and path pairs)                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin:tenants:provision` | `POST /api/admin/tenants`, `GET /api/admin/tenants/{id}` (id, code, name, description, isolation policy and lifecycle state only), `GET /api/admin/tenants/{id}/provisioning`, `POST /api/admin/tenants/{id}/provisioning/retry`, `POST /api/admin/tenants/{id}/provisioning/cleanup` |
| `admin:tenants:delete`    | `DELETE /api/admin/tenants/{id}`, `POST /api/admin/tenants/{id}/deletion/cancel` (cancels a failed deletion before its point of no return; the same step-up as the deletion)                                                                                                          |

A global machine principal that holds `admin:settings:read` can also read platform settings
(`GET /api/admin/platform/settings/{category}`) and use the returned `version` as `ifMatch` for a
write; the write permission does not imply the read, and a token limited to some tenants is refused.
Categories only a super admin may view (for example `encryption`) stay closed to such a token; it
needs the global wildcard permission for them.

What they do not allow: every other route under `/api/admin/tenants` (list, update,
set-default, clone, lifecycle commands, jobs, placement migrations, runtime registry purge), and
every other system-admin route (platform settings, plugins, initial access tokens, rate-limit
overrides). A **human** is not helped by either permission: a human still needs the global
`ar_super_admin` role for these routes, however the permission was obtained (for example through a
custom global role).

- The principal needs a **global tenant scope** (scope mode `all`); a token limited to some tenants
  holds nothing for the platform and is refused, permission or not. Mint the token on the host it
  is used on, and send `X-Tenant-Id` for in-tenant calls (the tenant routes above do not need it).
- **Deleting keeps its step-up.** While admin step-up is enforced (the default), the principal
  also needs the exact-name `admin:step_up_exempt:tenant.delete`; without it the step-up gate
  refuses a machine (`403 step_up_human_required`). Where the platform has turned admin step-up off
  (`security.admin_step_up_enforced` false), the shared gate lets a machine through before it looks
  at the exemption, and the deletion permission alone is enough: a platform that relies on the
  exemption as a second barrier must keep step-up enforced. Exact-name permissions are not implied by `*`, `admin:*` or any
  wildcard, so nobody holds the exemption through a wildcard. A signed-in human with the global
  `ar_super_admin` role hands it (`admin:step_up_exempt:<operation>`) to a machine principal or
  credential through the machine access API, with the `machine.permission.grant` L2 step-up; any
  other actor can hand out only an exemption it holds by exact name. The super admin's addition
  covers an exemption for a known operation only, and neither one the step-up gate always enforces
  (the exemption has no effect there) nor `machine.permission.grant` itself.
- **Refusals an automation should expect (all 409, nothing changed):**
  - `tenant_state_changed` on delete or set-default: the tenant became the default, left an
    allowed state, or already has a deletion queued. Read the tenant and decide again; do not
    blindly resend.
  - `tenant_deletion_in_progress` on set-default and on resume, unfreeze and restore-validate:
    the tenant has a deletion queued or running. Wait for that job to fail or complete (a
    `processing` job untouched for 6 hours stops counting), then decide again.
  - `tenant_deletion_failed_use_cancel` on resume, unfreeze and restore-validate: the tenant's
    last deletion failed and its route is still quarantining, quarantined or disabled, or its
    cancellation is incomplete (resume would flip the tenant row but leave the route out of
    service; repeat the cancel to complete it). Cancel the deletion first with
    `POST /api/admin/tenants/{id}/deletion/cancel` (body `{ "reason": "..." }`; needs the
    deletion permission and the same step-up as deletion); it reactivates the route, marks the
    failed job cancelled and leaves the tenant `suspended`, and `resume` then works. Cancel
    works on all the tenant's failed deletion jobs together, takes a 120 second lease on its
    mark (`409 tenant_deletion_cancel_in_progress` for a repeat inside it), and answers
    `409 tenant_deletion_past_point_of_no_return` once the route is disabled, a job of the chain
    wrote its destructive-step marker, Control has finalised the deletion, or (for a job from
    before the marker) the Lookup identifier table shows the disable or cannot show anything (the
    deletion has to finish),
    `409 tenant_route_owned_by_other_operation` for a route held by another operation (for
    example a disaster recovery), `409 tenant_deletion_not_failed` /
    `tenant_deletion_in_progress` / `tenant_state_changed`, and `503` when the route, Control, the
    Lookup directory or the audit write cannot be read or written (nothing is changed).
  - `tenant_provisioning_cleanup_conflict` on cleanup: the operation is running, finished, or at
    Lookup activation, or moved while cleanup started. Once activation has begun, retry
    provisioning instead of cleaning up.
  - A reactivation accepted before a deletion started yields to it and activates nothing, ending
    as `partial_failure` in one of two ways: if the tenant is already `deleting` when the job
    starts, the common lifecycle gate ends it (stage `blocked_by_tenant_lifecycle`, error
    `tenant_lifecycle_blocked:deleting`); if a deletion was accepted after the command (even
    if it has failed since and left the tenant in the job's source state, or is still pending or
    running), or the state changed, the reactivating statement matches nothing (stage
    `tenant_lifecycle_validation_superseded`). Send a new command if the tenant should still come
    back.
- **Create defaults to `tenant_exclusive`**, which allocates owned database capacity. Automation
  should pass `isolation_policy` explicitly.
- The created tenant, the deletion job and their audit entries record the caller: the Admin user
  id for a human, the machine principal id and `admin_actor_type: machine` for a machine.

#### Enrollment code handoff (a provisioning portal without `admin:*`)

Normally the one-time enrollment code of an admin invitation is e-mailed to the person invited. A
trusted **global machine principal** (a provisioning portal) can instead receive the code in the
`POST /api/admin/admin-invitations` response by sending `"code_delivery": "response"`. Nothing is
e-mailed. It is off, and unreachable for everyone else, unless all of this holds:

- **Who.** A machine access token with a **global tenant scope** holding the exact-name permission
  `admin:admin_invitations:code_handoff`. No wildcard (`*`, `admin:*`, `admin:admin_invitations:*`)
  carries it, no built-in role lists it, and a human with the global `ar_super_admin` role hands
  it to a principal through the machine access API, which asks for the `machine.permission.grant`
  L2 step-up. Any other actor can hand it out only if it holds it by exact name. **A human can never
  use it, whatever their role.** A token limited to some tenants is refused. The write pair
  (`admin:admin_users:write` and `admin:admin_roles:write`) is still required; the handoff
  permission replaces only the rank comparison (a machine ranks 0) and the `admin.role.grant`
  step-up, and only in this mode. Holding the permission gives a machine nothing in the e-mail
  mode, and the step-up exemption of `admin.role.grant` alone gives it nothing at all: a machine
  ranks 0, so it invites no role by e-mail, and a role with a negative level is refused for it.
- **The platform switch.** Setting `admin_invitations.code_handoff_enabled` (category
  `admin-invitations`, platform scope only, environment variable
  `ADMIN_INVITATIONS_CODE_HANDOFF_ENABLED`, default **off**). It is read without the settings
  cache, and an unreadable value counts as off (`403 code_handoff_disabled`). Turning it **on**,
  through the platform PATCH, a bulk apply or any other settings write, needs a signed-in human
  with an L2 step-up (`admin_invitation.code_handoff.enable`); a machine can never do it, even with
  a step-up exemption or while the platform has turned step-up enforcement off. Turning it off is
  free.
- **What it may invite.** A tenant-scoped invitation for the request tenant, to a role that is not
  `ar_super_admin`, not a platform role, carries no wildcard permission, and ranks from 0 up to but
  not including the super admin level. No admin groups (`group_ids`). Otherwise `403
code_handoff_role_not_allowed`, `400 invalid_scope` or `400 code_handoff_groups_not_supported`.
- **Lifetime.** 15 minutes by default; `expires_in_minutes` (1 to 60) sets it. `expires_in_hours` is
  refused with the handoff.

The 201 response has `code`, `code_delivery: "response"`, `email_sent: false` and `join_url` (the
join page without the code, or null when `ADMIN_UI_URL` is not a safe origin), with
`Cache-Control: no-store`. The code is shown once, never logged or audited, and only its hash is
stored; the audit entry records `code_delivery: response` and the machine principal.

- **The address is not verified.** Nobody proved that the invited address is the person's, so
  accepting such an invitation creates the admin with `email_verified` off. Features that need a
  verified admin address (for example an approval code by e-mail) are not offered to that admin
  and answer as they do for any admin without one.
- **Passing the code on.** Put it in the URL **fragment**, `join_url#code=XXXX-XXXX-XXXX-XXXX&email=...`.
  A fragment is never sent to a server, and the Admin console join page reads it, fills in the form
  (it does not submit), and removes it from the address bar and the history at once. A query string
  is never read.
- **Re-issue and revoke.** An invitation keeps its delivery: e-mail resend of a handed-over
  invitation, and a handoff re-issue of an e-mailed one, are `409 code_delivery_mismatch`. The
  portal re-issues a handed-over code by `POST /api/admin/admin-invitations/{id}/resend` with
  `"code_delivery": "response"` (same conditions as creating), or revokes it with `DELETE`; the
  handoff permission alone revokes a tenant-scoped handed-over invitation, and only those.
- The migration `016_admin_invitation_code_delivery.sql` adds the column `code_delivery`
  (`email` or `response`) to `admin_invitations`; a handed-over invitation reads as `sent` in
  `last_delivery_status`.

#### Tenants an all-tenants machine scope does not include

A machine principal's tenant scope is `all` or an allow-list of tenant IDs. An integration that has
to work on tenants created at runtime must be given `all`, and `all` includes the deployment's
primary tenant (`default`), where the platform's own administration lives: a stolen key of such a
principal, holding for example `admin:admin_users:write`, `admin:admin_roles:write` and the
enrollment code handoff permission, could enrol a tenant administrator of the primary tenant. The
platform setting `machine_access.all_scope_excluded_tenants` (category `machine-access`, platform
scope only, environment variable `MACHINE_ACCESS_ALL_SCOPE_EXCLUDED_TENANTS`) names tenants that an
all-tenants scope does not reach. Default: empty, which changes nothing.

- **Value.** A comma-separated list of at most 50 distinct lowercase tenant IDs, for example
  `default`. A malformed value is refused when saved (a wildcard, an uppercase or empty entry, a
  repeat, more than 50), with a message naming the setting.
- **What is refused.** For a listed tenant, a machine access token whose scope is all tenants gets
  `403 access_denied` ("Admin machine credential is not valid for this tenant.", the answer of a
  tenant outside the token's scope, so it reveals nothing more) unless **both its principal and its
  credential name that tenant in an `allow` scope entry of their own** (an `allow` entry next to the
  `all` one counts; a credential without a scope of its own follows its principal). The Admin API
  authentication refuses on every request, judging by the router's path (`c.req.path`, never the raw
  URL):
  - the **request tenant** (`X-Tenant-Id`) of every route that runs in a tenant: the
    tenant-scoped Admin API (users, apps, settings, admin users, admin invitations including the
    code handoff, and so on) and the protocol-style routes that use the same authentication (for
    example the ReBAC write routes);
  - the **tenant the path names** (`/api/admin/tenants/{id}/...`,
    `/api/admin/settings/logging/tenant/{id}`), whatever the class of the route, so a tenant
    inventory operation on a listed tenant (delete, provisioning clean-up or retry, lifecycle,
    clone, set-default) is refused too;
  - **tenants the request names elsewhere**, for every route: the query keys `tenant_id`,
    `tenantId`, `filter[tenant_id]` and `tenant` (comma lists included), the `X-Tenant-Id` header
    of a platform route, and the top-level `tenant_id`, `tenantId`, `tenant_ids` and `tenantIds` of
    a JSON body (a JSON body over 1 MiB is not read and is refused for such a token, so padding
    cannot hide a tenant).
  - Ids are compared after percent-decoding (repeatedly), NFKC and case folding; a path segment
    that cannot be read counts as naming every listed tenant.
  - Handlers that take a tenant from a stored row, a nested field or a cross-tenant list judge it
    themselves with the same decision (`refuseMachineOnExcludedTenant`,
    `filterTenantsReachableByMachine`): domain mappings (create by body, read, change, delete and
    verify by the stored row's tenant, lists filtered), platform tombstones, platform plugin
    configuration and enablement, the PII partition statistics, the identity mapping set change
    preview, the list of every tenant's mapping settings (filtered in the query, so pages and the
    cursor stay right), last-resort recovery (an administrator of a listed tenant is not found), the
    agent baselines and bulk plans, and the settings bulk apply (each target tenant).
  - **Machine access management.** These stricter rules come into force **together with the list**:
    while it is empty, machine access management behaves exactly as before (for example a
    non-platform `admin:*` machine can still read and rotate a platform principal). Final rules:
    - _What a non-platform all-tenants machine sees and manages_ (list not empty, or unreadable):
      only what it reaches after the exclusion. It does not see, change, disable, delete or revoke
      a principal or credential that reaches a listed tenant, nor one that reaches every tenant
      (while any tenant is listed, "every tenant" includes a listed one, so such a principal is
      beyond its reach, itself included), nor a platform principal; and it cannot hand out such a
      reach.
    - _What counts as a grant to a protected tenant_: a request that GRANTS or WIDENS access to a
      listed tenant, or creates, enables or widens a platform principal (the setup tool, the Admin
      console relay, an internal service): a new principal or credential, a rotated key (a new key
      is a new grant), an added permission, an added or widened tenant scope, a disabled principal
      or revoked key brought back. What a tenant is named as is what authentication will accept:
      the principal's scope narrowed by the credential's, plus the tenants named explicitly next to
      an `all` entry, compared key by key. Renaming, changing a description, narrowing, disabling,
      revoking and deleting are never grants and never ask for more than before, so taking access
      away stays easy, for a tenant administrator of a listed tenant too.
    - _A wildcard replaced by an exact name_ (`admin:users:*` to `admin:users:read`) is treated as a
      grant although it looks like narrowing: while a list is in force, a permission held by its
      exact stored name is what gives an all-scope machine cross-tenant authority, and a wildcard
      does not.
    - _Who may grant it_: only a signed-in platform administrator (global machine-access write),
      with an L2 step-up `machine.protected_grant` that the enforcement switch cannot turn off and
      no exemption covers. A machine token is refused before the step-up
      (`403 step_up_human_required`), whatever it holds; a tenant administrator who is not a
      platform administrator is refused. When the request also needs the grant's own step-up
      (`machine.permission.grant`), it takes ONE receipt covering both operations (`alsoCovers`),
      with the parameters bound as before.
    - _Races_: a principal's revision covers its keys (status, window, scopes, permissions), and a
      key's write is guarded on the principal's revision it read, so a principal change decided
      against one set of keys, or a key change decided against an older principal scope, is refused
      with the existing 409 and has to be retried.
    - _Unreadable setting_: it is read only where a decision needs it (a machine caller's view, a
      granting operation), once per request. It never fails a human's non-granting operation. For
      a human's granting operation it makes the always-enforced step-up required for any named
      tenant and any platform grant, and never an outright refusal: a platform administrator can
      always work (a human who is not a platform administrator is not refused either, the step-up
      is what they need). For a machine, an unreadable setting is a listed list (fail closed).

  - **A tenant that is not named.** An operation that names no tenant (a platform-wide plugin list,
    configuration read or update, enable) is not judged by this check; one that names a listed
    tenant, or names a tenant that cannot be resolved, is.

- **What is not refused.** Operations on the platform or on another tenant that run on the primary
  tenant's host and name no listed tenant: creating a tenant, listing tenants, reading provisioning
  of or deleting another tenant, and the `/api/admin/platform/*` operations that are not about a
  tenant (the trial start portal keeps working). Tokens limited to named tenants; agent and
  delegated grants (they already name their tenant); signed-in humans; and the **platform principal
  types** `setup_tool`, `admin_ui_bff` and `internal_service` (and the bootstrap principals by their
  fixed ids), which are created only by a platform administrator and whose type never changes. The
  setup tool, the Admin console relay and last-resort recovery therefore cannot be locked out by
  this setting.
- **A wildcard is no cross-tenant authority while tenants are listed.** While the list is in force
  (not empty, or the setting cannot be read), a non-platform all-tenants machine does not get
  platform authority from a wildcard (`*`, `admin:*`, any `x:*`). The Admin API authentication marks
  such a caller (`tenantExclusionActive`), and the one function every platform-authority check goes
  through (`hasGlobalAdminPermission`, hence `hasGlobalMachinePermission`,
  `hasGlobalPlatformAuthority`, `requireSystemAdmin` and the handlers' own "platform authority"
  wrappers) then accepts only a permission the machine holds **by its exact name**, and asked for a
  wildcard pattern it says no. The control plane's permission check, the cross-tenant machine
  shortcut of `canAccessTenantResource` and the platform-owner scope of the identity mapping
  routes follow the same rule. So a handler's "platform authority, skip the tenant comparison"
  shortcut stops applying and the machine is confined to the request's tenant (already judged),
  unless the route names an exact permission it holds (`admin:tenants:provision`,
  `admin:tenants:delete`, `admin:admin_users:write`, `admin:admin_invitations:code_handoff`, ...).
  Nothing changes while the list is empty, for humans, or for the platform principal types.
- **What it does not protect against.** A machine that holds an exact platform-wide permission
  (for example `admin:settings:write` for every tenant) keeps what that permission gives: the
  operations that act on the whole platform (writing a platform setting, the control plane with its
  exact permission, platform profiles) are not narrowed to a tenant. The list of tenants is not
  filtered from `GET /api/admin/tenants`. Give an integration the specific permissions it needs,
  never a wildcard. `packages/ar-management/src/__tests__/platform-route-tenant-targets.test.ts`
  forces review of new files and new route prefixes that read a tenant from the query or the body,
  and checks that every tenant resolution in the plugin and tombstone handlers is followed by the
  shared check; it does not force review of every new call site elsewhere or of a new child route
  under a listed prefix.
- **Request bodies.** A body is read for these tokens whatever its Content-Type says (a handler's
  `c.req.json()` parses any body), up to 1 MiB, counting bytes; a larger body is refused. No admin
  handler reads a tenant ID from form data (the two that read forms take the tenant from the
  request context), so a form body is covered by the same JSON attempt and is otherwise left alone.
- **Recommended value** for a deployment that lets an automation create tenants (a provisioning
  portal with scope `all`): the primary tenant, `default`. The automation then keeps creating and
  reading other tenants, and cannot act inside the primary tenant.
- **When it takes effect.** The value is read at each request of an all-tenants non-platform
  machine token without the per-isolate settings cache, and the grants are read from the database
  on every use, so a saved change applies to the next request, with the token it already holds
  (tokens are not reissued); the only delay is the propagation of the settings store itself.
- **If it cannot be read.** A value that cannot be read, or that is not a valid list (a stored
  `null` included, which never reads as "not set"), counts as every tenant listed: an all-tenants
  machine token of a non-platform principal that does not name its tenants is refused until the
  setting is readable again, **even when no list was ever saved**. Humans, platform principals and
  tokens naming their tenants keep working, so the operator can always repair the setting. The
  setting is read at most once per request.
- **Changing it.** Adding a tenant is free. Removing a tenant, emptying the list or replacing it
  with one that drops a tenant needs a signed-in human with an L2 step-up
  (`machine_access.excluded_tenants.relax`); a machine can never do it, exemption or not, through
  the platform PATCH or any other settings write. It cannot be set for a tenant or in a bulk apply.
  In the Admin console it is under Settings > Administrators > Sign-in settings > Machine access
  to protected tenants, shown to platform administrators.

#### Preset roles of the service's users

Only two roles are preset. Business roles (billing, support, per-department roles) are created by
whoever runs Authrim, in the Admin API or the Admin console.

| Role       | Description                                                                   |
| ---------- | ----------------------------------------------------------------------------- |
| `admin`    | Administrators of the service's own users. Full access in the default policy. |
| `end_user` | Standard user role.                                                           |

Names that start with `ar_` are reserved for the Admin roles above, and the preset names cannot be
used for a new role. Organization and group features do not depend on a preset: a role created by
the operator can be scoped to an organization like any other.

### Type Definitions

#### PolicySubject

```typescript
interface PolicySubject {
  /** Subject identifier (user ID) */
  id: string;

  /** User type classification */
  userType?: UserType;

  /** Roles assigned to the subject */
  roles: SubjectRole[];

  /** Primary organization ID */
  orgId?: string;

  /** Organization plan (for plan-based policies) */
  plan?: PlanType;

  /** Organization type */
  orgType?: OrganizationType;

  /** Relationships where this subject is the parent/guardian */
  relationships?: SubjectRelationship[];
}
```

#### SubjectRole

```typescript
interface SubjectRole {
  /** Role name (e.g., 'admin', 'end_user', or a role the operator created) */
  name: string;

  /** Scope of the role: 'global' | 'org' | 'resource' */
  scope: ScopeType;

  /** Scope target (e.g., 'org:org_123', 'resource:doc_456') */
  scopeTarget?: string;

  /** Expiration timestamp (UNIX milliseconds) */
  expiresAt?: number;
}
```

### Scoped Roles

Roles support three scope levels:

| Scope      | Description                      | Example                           |
| ---------- | -------------------------------- | --------------------------------- |
| `global`   | Applies everywhere               | System administrator              |
| `org`      | Limited to specific organization | `scopeTarget: "org:org_123"`      |
| `resource` | Limited to specific resource     | `scopeTarget: "resource:doc_456"` |

**Scope Resolution:**

- Global scope matches all scope requirements
- Org scope only matches within the same organization
- Resource scope only matches the specific resource

### RBAC Condition Types

| Condition           | Description                         | Parameters                          |
| ------------------- | ----------------------------------- | ----------------------------------- |
| `has_role`          | Subject has specific role           | `{ role, scope?, scopeTarget? }`    |
| `has_any_role`      | Subject has any of roles (OR)       | `{ roles[], scope?, scopeTarget? }` |
| `has_all_roles`     | Subject has all roles (AND)         | `{ roles[], scope?, scopeTarget? }` |
| `is_resource_owner` | Subject owns the resource           | `{}`                                |
| `same_organization` | Subject and resource in same org    | `{}`                                |
| `has_relationship`  | Subject has relationship with owner | `{ types[] }`                       |
| `user_type_is`      | Subject's user type matches         | `{ types[] }`                       |
| `plan_allows`       | Organization plan allows action     | `{ plans[] }`                       |

### Role Checker Utilities

Located in `packages/ar-lib-policy/src/role-checker.ts`:

```typescript
import {
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  isSystemAdmin,
  isOrgAdmin,
  getActiveRoles,
  subjectFromClaims,
} from '@authrim/ar-lib-policy';

// Check single role
if (hasRole(subject, 'billing_manager', { scope: 'org', scopeTarget: 'org:123' })) {
  // User is admin of organization 123
}

// Check any role (OR)
if (hasAnyRole(subject, ['admin', 'billing_manager'])) {
  // User has at least one admin role
}

// Check all roles (AND)
if (hasAllRoles(subject, ['viewer', 'commenter'])) {
  // User has both roles
}

// Quick admin check (the preset `admin` role)
if (isAdmin(subject)) {
  /* ... */
}

// Get active roles
const activeRoles = getActiveRoles(subject, { scope: 'org', scopeTarget: 'org:123' });

// Create subject from JWT claims
const subject = subjectFromClaims({
  sub: 'user_123',
  authrim_roles: ['end_user', 'billing_manager'],
  authrim_org_id: 'org_456',
  authrim_plan: 'professional',
});
```

### Default Policy Rules

The default policy engine includes these built-in rules:

```typescript
const defaultRules = [
  {
    id: 'admin_full_access',
    name: 'Admin Full Access',
    priority: 1000,
    effect: 'allow',
    conditions: [{ type: 'has_role', params: { role: 'admin' } }],
  },
  {
    id: 'owner_full_access',
    name: 'Resource Owner Access',
    priority: 700,
    effect: 'allow',
    conditions: [{ type: 'is_resource_owner', params: {} }],
  },
  {
    id: 'guardian_access',
    name: 'Guardian Access',
    priority: 600,
    effect: 'allow',
    conditions: [{ type: 'has_relationship', params: { types: ['parent_of', 'guardian_of'] } }],
  },
];
```

---

## ABAC (Attribute-Based Access Control)

### Core Concepts

ABAC enables flexible attribute-based evaluation with support for Verifiable Credentials (VC) and KYC integration.

### Type Definitions

#### VerifiedAttribute

```typescript
interface VerifiedAttribute {
  /** Attribute name (e.g., 'age_over_18', 'subscription_tier') */
  name: string;

  /** Attribute value */
  value: string | null;

  /** Source of the attribute */
  source: 'manual' | 'vc' | 'jwt_sd' | 'kyc_provider';

  /** Issuer (DID or URL) for VC-sourced attributes */
  issuer?: string;

  /** Expiration timestamp (UNIX seconds) */
  expiresAt?: number;
}
```

#### PolicySubjectWithAttributes

```typescript
interface PolicySubjectWithAttributes extends PolicySubject {
  /** Verified attributes for ABAC evaluation */
  verifiedAttributes?: VerifiedAttribute[];
}
```

### Attribute Sources

| Source         | Description                   | Use Case                       |
| -------------- | ----------------------------- | ------------------------------ |
| `manual`       | Manually assigned by admin    | Internal policies              |
| `vc`           | Verifiable Credential         | External identity verification |
| `jwt_sd`       | SD-JWT (Selective Disclosure) | Privacy-preserving claims      |
| `kyc_provider` | KYC service verification      | Age/identity verification      |

### ABAC Condition Types

| Condition          | Description                      | Parameters                         |
| ------------------ | -------------------------------- | ---------------------------------- |
| `attribute_equals` | Attribute matches specific value | `{ name, value, checkExpiry? }`    |
| `attribute_exists` | Attribute exists (any value)     | `{ name, checkExpiry? }`           |
| `attribute_in`     | Attribute value in allowed list  | `{ name, values[], checkExpiry? }` |

### Time-Based Conditions (Phase 4+)

| Condition       | Description                               | Parameters                                 |
| --------------- | ----------------------------------------- | ------------------------------------------ |
| `time_in_range` | Check if current time is within hours     | `{ startHour, endHour, timezone? }`        |
| `day_of_week`   | Check if current day matches allowed days | `{ allowedDays: number[], timezone? }`     |
| `valid_during`  | Check if current time is within period    | `{ from?: unixSeconds, to?: unixSeconds }` |

### Numeric Conditions (Phase 4+)

| Condition         | Description                  | Parameters           |
| ----------------- | ---------------------------- | -------------------- |
| `numeric_gt`      | Attribute value > threshold  | `{ name, value }`    |
| `numeric_gte`     | Attribute value >= threshold | `{ name, value }`    |
| `numeric_lt`      | Attribute value < threshold  | `{ name, value }`    |
| `numeric_lte`     | Attribute value <= threshold | `{ name, value }`    |
| `numeric_eq`      | Attribute value == threshold | `{ name, value }`    |
| `numeric_between` | Attribute value within range | `{ name, min, max }` |

### Geographic Conditions (Phase 4+)

| Condition        | Description                        | Parameters                |
| ---------------- | ---------------------------------- | ------------------------- |
| `country_in`     | Request from allowed countries     | `{ countries: string[] }` |
| `country_not_in` | Request not from blocked countries | `{ countries: string[] }` |
| `ip_in_range`    | Client IP in CIDR ranges           | `{ ranges: string[] }`    |

### ABAC Condition Examples

```typescript
// Check subscription tier
{
  type: 'attribute_equals',
  params: {
    name: 'subscription_tier',
    value: 'premium',
    checkExpiry: true  // Default: true
  }
}

// Check if medical license exists
{
  type: 'attribute_exists',
  params: {
    name: 'medical_license'
  }
}

// Check role level in allowed list
{
  type: 'attribute_in',
  params: {
    name: 'role_level',
    values: ['senior', 'lead', 'manager']
  }
}

// Time-based: Business hours only (9 AM - 6 PM UTC)
{
  type: 'time_in_range',
  params: {
    startHour: 9,
    endHour: 18,
    timezone: 'UTC'
  }
}

// Day of week: Weekdays only (Monday=1 to Friday=5)
{
  type: 'day_of_week',
  params: {
    allowedDays: [1, 2, 3, 4, 5],
    timezone: 'America/New_York'
  }
}

// Numeric: Premium tier (>= 2)
{
  type: 'numeric_gte',
  params: {
    name: 'subscription_tier',
    value: 2
  }
}

// Numeric: Credits within range
{
  type: 'numeric_between',
  params: {
    name: 'credits',
    min: 10,
    max: 100
  }
}

// Geographic: Allow only from specific countries
{
  type: 'country_in',
  params: {
    countries: ['JP', 'US', 'GB']
  }
}

// Geographic: Block high-risk countries
{
  type: 'country_not_in',
  params: {
    countries: ['XX', 'YY']  // Replace with actual codes
  }
}

// Geographic: Office IP ranges only
{
  type: 'ip_in_range',
  params: {
    ranges: ['192.168.1.0/24', '10.0.0.0/8']
  }
}
```

### ABAC Policy Rule Example

```typescript
const premiumFeatureRule: PolicyRule = {
  id: 'premium_feature_access',
  name: 'Premium Feature Access',
  description: 'Only premium subscribers can access this feature',
  priority: 500,
  effect: 'allow',
  conditions: [
    {
      type: 'attribute_equals',
      params: { name: 'subscription_tier', value: 'premium' },
    },
  ],
};
```

### Verified Attributes Database Schema

```sql
CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, subject_id, attribute_name)
);
```

---

## ReBAC (Relationship-Based Access Control)

### Core Concepts

ReBAC provides a **Zanzibar-lite** implementation for relationship-based access control with support for:

- Direct relationships
- Union (OR) expressions
- Transitive relationships (tuple-to-userset)
- Closure table for efficient list operations

### Check Request/Response

#### CheckRequest

```typescript
interface CheckRequest {
  /** Tenant ID for multi-tenant isolation */
  tenant_id: string;

  /** Subject (user) identifier - "user:user_123" or "user_123" */
  user_id: string;

  /** Relation to check - "viewer", "editor", "owner" */
  relation: string;

  /** Object identifier - "document:doc_456" */
  object: string;

  /** Optional: Object type if not embedded in object string */
  object_type?: string;

  /** Optional: Context for conditional checks (Phase 4+) */
  context?: {
    /** Temporary relationships to consider for this check only */
    contextual_tuples?: Array<{
      user_id: string;
      relation: string;
      object: string;
    }>;
    [key: string]: unknown;
  };
}
```

#### CheckResponse

```typescript
interface CheckResponse {
  /** Whether the check is allowed */
  allowed: boolean;

  /** How the result was resolved */
  resolved_via?: 'direct' | 'computed' | 'cache' | 'closure' | 'context';

  /** Path through relationships (for debugging) */
  path?: string[];

  /** Cached until timestamp (for debugging) */
  cached_until?: number;
}
```

### Contextual Tuples (Phase 4+)

Contextual tuples allow passing temporary relationships in a check request. These are evaluated **before** cache lookup and provide request-specific permission grants without persisting to the database.

**Use Cases:**

- Preview mode: "What if user X had access to resource Y?"
- Temporary grants: Short-lived permissions for specific operations
- Testing: Simulating relationships in development/testing

**Example:**

```typescript
const checkRequest: CheckRequest = {
  tenant_id: 'tenant_1',
  user_id: 'user_123',
  relation: 'viewer',
  object: 'document:doc_456',
  context: {
    contextual_tuples: [
      {
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_456',
      },
    ],
  },
};
```

**Behavior:**

1. Contextual tuples are checked **first** (before cache/DB)
2. If a match is found, `resolved_via: 'context'` is returned
3. Contextual tuples are NOT cached (request-scoped only)
4. Maximum 100 tuples per request (DoS protection)

### Relation DSL (Domain-Specific Language)

The Relation DSL defines how relations are computed for object types.

#### DirectRelation

Matches a specific relation tuple directly.

```typescript
interface DirectRelation {
  type: 'direct';
  relation: string; // e.g., "viewer"
}
```

**Example:**

```json
{ "type": "direct", "relation": "viewer" }
```

#### UnionRelation

OR of multiple expressions (any must match).

```typescript
interface UnionRelation {
  type: 'union';
  children: RelationExpression[];
}
```

**Example:**

```json
{
  "type": "union",
  "children": [
    { "type": "direct", "relation": "owner" },
    { "type": "direct", "relation": "editor" },
    { "type": "direct", "relation": "viewer" }
  ]
}
```

#### TupleToUsersetRelation

Inherit permissions from related objects (transitive).

```typescript
interface TupleToUsersetRelation {
  type: 'tuple_to_userset';
  tupleset: {
    relation: string; // Relation to traverse (e.g., "parent")
  };
  computed_userset: {
    relation: string; // Relation to check on related object (e.g., "viewer")
  };
}
```

**Example:** Document inherits viewer permissions from parent folder.

```json
{
  "type": "tuple_to_userset",
  "tupleset": { "relation": "parent" },
  "computed_userset": { "relation": "viewer" }
}
```

#### IntersectionRelation (Phase 4+)

AND of multiple expressions (all must match).

```typescript
interface IntersectionRelation {
  type: 'intersection';
  children: RelationExpression[];
}
```

#### ExclusionRelation (Phase 4+)

NOT expression (base minus excluded).

```typescript
interface ExclusionRelation {
  type: 'exclusion';
  base: RelationExpression;
  subtract: RelationExpression;
}
```

### Complete Relation Definition Example

A document's `viewer` relation that includes direct viewers, editors, owners, and viewers of the parent folder:

```json
{
  "id": "def_doc_viewer",
  "tenant_id": "tenant_123",
  "object_type": "document",
  "relation_name": "viewer",
  "definition": {
    "type": "union",
    "children": [
      { "type": "direct", "relation": "owner" },
      { "type": "direct", "relation": "editor" },
      { "type": "direct", "relation": "viewer" },
      {
        "type": "tuple_to_userset",
        "tupleset": { "relation": "parent" },
        "computed_userset": { "relation": "viewer" }
      }
    ]
  },
  "priority": 100,
  "is_active": true
}
```

### ReBAC Service Configuration

```typescript
interface ReBACConfig {
  /** KV namespace for caching */
  cache_namespace?: KVNamespace;

  /** Cache TTL in seconds (default: 60) */
  cache_ttl?: number;

  /** Maximum recursion depth (default: 5) */
  max_depth?: number;

  /** Enable closure table for list operations */
  enable_closure_table?: boolean;

  /** Batch size for closure table updates */
  closure_batch_size?: number;
}
```

### Resolution Order

1. **Request-scoped cache** - Deduplication within single request
2. **KV cache** - TTL-based cache (default: 60s)
3. **Recursive CTE** - Database computation with cycle detection

### Safety Features

| Feature                | Implementation                  |
| ---------------------- | ------------------------------- |
| Cycle detection        | `visited` Set tracking          |
| Depth limiting         | `DEFAULT_MAX_DEPTH = 5`         |
| Cache invalidation     | TTL-based + manual invalidation |
| Multi-tenant isolation | `tenant_id` on all queries      |

### List Operations

For efficient listing of objects/users, ReBAC uses a pre-computed **closure table**:

```typescript
// List objects user can access
interface ListObjectsRequest {
  tenant_id: string;
  user_id: string;
  relation: string;
  object_type: string;
  limit?: number;
  cursor?: string;
}

// List users with access to object
interface ListUsersRequest {
  tenant_id: string;
  object: string;
  object_type?: string;
  relation: string;
  limit?: number;
  cursor?: string;
}
```

### Relationship Tuple Format

Following Zanzibar conventions:

```
object#relation@user
```

**Example:** `document:doc_123#viewer@user:user_456`

```typescript
interface RelationshipTuple {
  object_type: string; // "document"
  object_id: string; // "doc_123"
  relation: string; // "viewer"
  subject_type: string; // "user"
  subject_id: string; // "user_456"
  subject_relation?: string; // For userset subjects
}
```

---

## Unified Check Service

### Evaluation Order

The Unified Check Service evaluates permissions in this order (first match wins):

| Priority | Check Type    | Description                                 |
| -------- | ------------- | ------------------------------------------- |
| 1        | ID-Level      | `resource:id:action` format (most specific) |
| 2        | RBAC          | Role-based conditions                       |
| 3        | ReBAC         | Relationship evaluation                     |
| 4        | ABAC/Computed | Attribute-based conditions                  |

### Permission Formats

```typescript
// String formats
"documents:read"           // Type-level
"documents:doc_123:read"   // ID-level

// Object format
{
  resource: "documents",
  id: "doc_123",           // Optional for type-level
  action: "read"
}
```

### Check API Request

```typescript
interface CheckApiRequest {
  /** Subject ID (user or service) */
  subject_id: string;

  /** Subject type */
  subject_type?: 'user' | 'service';

  /** Permission to check */
  permission: string | { resource: string; id?: string; action: string };

  /** Tenant ID */
  tenant_id?: string;

  /** Resource context for ABAC */
  resource_context?: {
    owner_id?: string;
    org_id?: string;
    attributes?: Record<string, unknown>;
  };

  /** ReBAC parameters */
  rebac?: {
    relation: string;
    object: string;
  };
}
```

### Check API Response

```typescript
interface CheckApiResponse {
  /** Whether access is allowed */
  allowed: boolean;

  /** How the result was resolved */
  resolved_via: ('id_level' | 'role' | 'rebac' | 'computed')[];

  /** Final decision */
  final_decision: 'allow' | 'deny';

  /** Reason for denial */
  reason?: string;

  /** Cache TTL in seconds */
  cache_ttl?: number;

  /** Debug information */
  debug?: {
    matched_rules?: string[];
    path?: string[];
    evaluation_time_ms?: number;
  };
}
```

### Batch Check

```typescript
// Request
interface BatchCheckRequest {
  checks: CheckApiRequest[];
  stop_on_deny?: boolean; // Stop processing on first deny
}

// Response
interface BatchCheckResponse {
  results: CheckApiResponse[];
  summary: {
    total: number;
    allowed: number;
    denied: number;
    evaluation_time_ms: number;
  };
}
```

---

## Feature Flags

### Available Flags

| Flag                         | Default | Description                               |
| ---------------------------- | ------- | ----------------------------------------- |
| `ENABLE_ABAC`                | `false` | Enable Attribute-Based Access Control     |
| `ENABLE_REBAC`               | `false` | Enable Relationship-Based Access Control  |
| `ENABLE_POLICY_LOGGING`      | `false` | Enable detailed policy evaluation logging |
| `ENABLE_VERIFIED_ATTRIBUTES` | `false` | Enable verified attributes checking       |
| `ENABLE_CUSTOM_RULES`        | `true`  | Enable custom policy rules                |
| `ENABLE_SD_JWT`              | `false` | Enable SD-JWT for ID Token issuance       |
| `ENABLE_POLICY_EMBEDDING`    | `false` | Enable permission embedding in tokens     |

### Resolution Priority

```
KV Override > Environment Variable > Default Value
```

### Usage

```typescript
import { createFeatureFlagsManager } from '@authrim/ar-lib-policy';

const flagsManager = createFeatureFlagsManager(env, kvNamespace);

// Async flag check
const abacEnabled = await flagsManager.isAbacEnabled();
const rebacEnabled = await flagsManager.isRebacEnabled();

// Sync flag check (from cache/env only)
const flags = flagsManager.getFlagsSync();

// Set flag override in KV
await flagsManager.setFlag('ENABLE_ABAC', true);

// Clear flag override (revert to env/default)
await flagsManager.clearFlag('ENABLE_ABAC');
```

---

## API Reference

### Check Endpoints

#### POST /api/check

Single permission check.

**Request:**

```json
{
  "subject_id": "user_123",
  "permission": "documents:doc_456:read",
  "tenant_id": "tenant_abc"
}
```

**Response:**

```json
{
  "allowed": true,
  "resolved_via": ["id_level"],
  "final_decision": "allow",
  "cache_ttl": 60
}
```

#### POST /api/check/batch

Batch permission checks.

**Request:**

```json
{
  "checks": [
    { "subject_id": "user_123", "permission": "documents:read" },
    { "subject_id": "user_123", "permission": "documents:write" }
  ],
  "stop_on_deny": false
}
```

**Response:**

```json
{
  "results": [
    { "allowed": true, "resolved_via": ["role"], "final_decision": "allow" },
    {
      "allowed": false,
      "resolved_via": [],
      "final_decision": "deny",
      "reason": "no_matching_permission"
    }
  ],
  "summary": {
    "total": 2,
    "allowed": 1,
    "denied": 1,
    "evaluation_time_ms": 5.23
  }
}
```

### Authentication

| Method       | Header Format                     |
| ------------ | --------------------------------- |
| API Key      | `Authorization: Bearer chk_xxx`   |
| Access Token | `Authorization: Bearer eyJhbG...` |

### Rate Limiting

Response headers:

- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests
- `X-RateLimit-Reset`: Window reset timestamp

### Batch Size Limits

| Setting                      | Default | Max  |
| ---------------------------- | ------- | ---- |
| `CHECK_API_BATCH_SIZE_LIMIT` | 100     | 1000 |

---

## Database Schema

### Resource Permissions (ID-Level)

```sql
CREATE TABLE resource_permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  subject_type TEXT NOT NULL DEFAULT 'user',
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL,      -- JSON array: ["read", "write"]
  condition_json TEXT,             -- Optional JSON condition
  expires_at INTEGER,
  is_active INTEGER DEFAULT 1,
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, subject_type, subject_id, resource_type, resource_id)
);
```

### Relation Definitions (ReBAC)

```sql
CREATE TABLE relation_definitions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_type TEXT NOT NULL,
  relation_name TEXT NOT NULL,
  definition_json TEXT NOT NULL,   -- JSON RelationExpression
  description TEXT,
  priority INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id, object_type, relation_name)
);
```

### Relationship Closure (ReBAC Lists)

```sql
CREATE TABLE relationship_closure (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ancestor_type TEXT NOT NULL,
  ancestor_id TEXT NOT NULL,
  descendant_type TEXT NOT NULL,
  descendant_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  depth INTEGER NOT NULL,
  path_json TEXT,
  effective_permission TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### Verified Attributes (ABAC)

```sql
CREATE TABLE verified_attributes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  attribute_name TEXT NOT NULL,
  attribute_value TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  issuer TEXT,
  credential_id TEXT,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

---

## Usage Examples

### RBAC: Role-Based Access Check

```typescript
import { PolicyEngine, createDefaultPolicyEngine } from '@authrim/ar-lib-policy';

// Create engine with default rules
const engine = createDefaultPolicyEngine();

// Add custom rule
engine.addRule({
  id: 'project_manager_access',
  name: 'Project Manager Access',
  priority: 750,
  effect: 'allow',
  conditions: [
    { type: 'has_role', params: { role: 'project_manager' } },
    { type: 'same_organization', params: {} },
  ],
});

// Evaluate
const context: PolicyContext = {
  subject: {
    id: 'user_123',
    roles: [{ name: 'project_manager', scope: 'global' }],
    orgId: 'org_456',
  },
  resource: {
    type: 'project',
    id: 'proj_789',
    orgId: 'org_456',
  },
  action: { name: 'edit' },
  timestamp: Date.now(),
};

const decision = engine.evaluate(context);
// { allowed: true, reason: 'Rule "Project Manager Access" matched', decidedBy: 'project_manager_access' }
```

### ABAC: Attribute-Based Access Check

```typescript
const engine = new PolicyEngine();

// Premium feature rule
engine.addRule({
  id: 'premium_feature',
  name: 'Premium Feature Access',
  priority: 500,
  effect: 'allow',
  conditions: [
    {
      type: 'attribute_equals',
      params: { name: 'subscription_tier', value: 'premium' },
    },
  ],
});

const context: PolicyContext = {
  subject: {
    id: 'user_123',
    roles: [],
    verifiedAttributes: [{ name: 'subscription_tier', value: 'premium', source: 'manual' }],
  } as PolicySubjectWithAttributes,
  resource: { type: 'feature', id: 'advanced_analytics' },
  action: { name: 'access' },
  timestamp: Date.now(),
};

const decision = engine.evaluate(context);
```

### ReBAC: Relationship-Based Access Check

```typescript
import { createReBACService } from '@authrim/ar-lib-core';

const rebacService = createReBACService({
  db: D1_DATABASE,
  cache_namespace: KV_NAMESPACE,
  cache_ttl: 60,
  max_depth: 5,
});

// Check if user can view document
const result = await rebacService.check({
  tenant_id: 'tenant_123',
  user_id: 'user_456',
  relation: 'viewer',
  object: 'document:doc_789',
});

if (result.allowed) {
  console.log('Access granted via:', result.resolved_via);
  console.log('Path:', result.path);
}
```

### Unified Check: Combined Model Check

```typescript
import { createUnifiedCheckService } from '@authrim/ar-lib-core';

const checkService = createUnifiedCheckService({
  db: D1_DATABASE,
  cache: KV_NAMESPACE,
  rebacService: rebacService,
  cacheTTL: 60,
  debugMode: true,
});

// Single check
const result = await checkService.check({
  subject_id: 'user_123',
  permission: 'documents:doc_456:read',
  tenant_id: 'tenant_abc',
  rebac: {
    relation: 'viewer',
    object: 'document:doc_456',
  },
  resource_context: {
    owner_id: 'user_789',
    org_id: 'org_abc',
  },
});

// Batch check
const batchResult = await checkService.batchCheck({
  checks: [
    { subject_id: 'user_123', permission: 'documents:read' },
    { subject_id: 'user_123', permission: 'documents:write' },
    { subject_id: 'user_123', permission: 'documents:delete' },
  ],
  stop_on_deny: true,
});
```

---

## Best Practices

### 1. Choose the Right Model

| Scenario                           | Recommended Model |
| ---------------------------------- | ----------------- |
| Fixed organizational hierarchy     | RBAC              |
| Compliance/regulatory requirements | ABAC              |
| Resource sharing/collaboration     | ReBAC             |
| Simple admin vs user distinction   | RBAC              |
| Age-gated content                  | ABAC              |
| File/folder inheritance            | ReBAC             |

### 2. Performance Optimization

- **RBAC**: Embed roles in JWT for O(1) lookup
- **ABAC**: Use attribute caching, limit attribute count
- **ReBAC**: Use closure table for list operations, set appropriate `max_depth`

### 3. Security Recommendations

- Default to `deny` when no rules match
- Set appropriate TTLs for cached permissions
- Use `checkExpiry: true` for time-sensitive attributes
- Implement rate limiting on Check API
- Log all deny decisions for audit

### 4. Multi-Tenant Isolation

- Always include `tenant_id` in all queries
- Never allow cross-tenant permission checks
- Validate `tenant_id` matches authenticated tenant

### 5. Cache Management

- Use short TTLs (30-60s) for frequently changing permissions
- Implement cache invalidation on permission changes
- Monitor cache hit rates

---

## Comparison Matrix

### Feature Support

| Feature                  | RBAC | ABAC | ReBAC |
| ------------------------ | :--: | :--: | :---: |
| Role hierarchy           |  ✅  |  ❌  |  ❌   |
| Scoped roles             |  ✅  |  ❌  |  ❌   |
| Role expiration          |  ✅  |  ❌  |  ❌   |
| Attribute matching       |  ❌  |  ✅  |  ❌   |
| Attribute expiration     |  ❌  |  ✅  |  ❌   |
| VC integration           |  ❌  |  ✅  |  ❌   |
| Direct relationships     |  ❌  |  ❌  |  ✅   |
| Transitive relationships |  ❌  |  ❌  |  ✅   |
| Union (OR) expressions   |  ❌  |  ❌  |  ✅   |
| Intersection (AND)       |  ❌  |  ❌  |  ⏳   |
| Exclusion (NOT)          |  ❌  |  ❌  |  ⏳   |

### Condition Types

| RBAC (7)            | ABAC (3)           | ReBAC DSL          |
| ------------------- | ------------------ | ------------------ |
| `has_role`          | `attribute_equals` | `direct`           |
| `has_any_role`      | `attribute_exists` | `union`            |
| `has_all_roles`     | `attribute_in`     | `tuple_to_userset` |
| `is_resource_owner` |                    | `intersection` ⏳  |
| `same_organization` |                    | `exclusion` ⏳     |
| `has_relationship`  |                    |                    |
| `user_type_is`      |                    |                    |
| `plan_allows`       |                    |                    |

### Performance Characteristics

| Metric           | RBAC            | ABAC            | ReBAC        |
| ---------------- | --------------- | --------------- | ------------ |
| Time Complexity  | O(1)            | O(n)            | O(d)         |
| Space Complexity | O(r)            | O(a)            | O(e)         |
| Cache Strategy   | Token embedding | Attribute cache | KV + closure |
| Batch Efficiency | High            | Medium          | Low          |

Where:

- `r` = number of roles
- `a` = number of attributes
- `n` = attributes to evaluate
- `d` = relationship depth
- `e` = edges in relationship graph

---

## Implementation Status

### Current Status (as of 2026-01-16)

| Feature               | Model         | Status      | Test Coverage |
| --------------------- | ------------- | ----------- | ------------- |
| RBAC Core             | RBAC          | ✅ Complete | 53 tests      |
| Scoped Roles          | RBAC          | ✅ Complete | Included      |
| Role Hierarchy        | RBAC          | ✅ Complete | Included      |
| ABAC Core             | ABAC          | ✅ Complete | 44 tests      |
| Verified Attributes   | ABAC          | ✅ Complete | Included      |
| Attribute Expiration  | ABAC          | ✅ Complete | Included      |
| Time-based conditions | Phase 4       | ✅ Complete | 13 tests      |
| Numeric comparisons   | Phase 4       | ✅ Complete | 18 tests      |
| Geographic conditions | Phase 4       | ✅ Complete | 17 tests      |
| Unified Check Service | Integration   | ✅ Complete | 38 tests      |
| Feature Flags         | Configuration | ✅ Complete | 25 tests      |

**Total Test Count:** 186+ tests across ar-lib-policy

---

## Future Roadmap

### Phase 5+ Planned Features

| Feature                | Model      | Status              |
| ---------------------- | ---------- | ------------------- |
| Intersection relations | ReBAC      | Planned             |
| Exclusion relations    | ReBAC      | Planned             |
| Contextual tuples      | ReBAC      | Planned             |
| IPv6 support           | Geographic | Planned             |
| Rate-based conditions  | Advanced   | Under consideration |

---

> **Authrim** — Edge-native OpenID Connect Provider with comprehensive access control
