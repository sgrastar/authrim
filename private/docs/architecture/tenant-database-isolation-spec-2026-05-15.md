---
title: Authrim Storage Profile Specification
date: 2026-05-15
status: draft
scope: breaking-change
implementation_status: planned
---

# Authrim Storage Profile Specification

> Scope notice (2026-07-29): For new Tenant D1 control-plane environments, the
> [Tenant D1 Control Plane plan](../implementation/tenant-d1-control-plane/README.md) supersedes this
> document's database-per-tenant physical model, Control DB discovery-index placement, and HMAC
> rotation write policy. This document remains the baseline for existing storage profiles and concepts
> not explicitly replaced by that plan. Existing-environment migration is outside the new plan.

## Summary

Authrim will support deployment-level storage profiles instead of mixing shared and
dedicated storage inside one running installation.

The supported profiles are:

- `shared-d1`: all durable data stays in shared Cloudflare D1 databases.
- `tenant-d1`: control/discovery stays shared, while each tenant gets dedicated D1
  core and PII databases.
- `external-durable`: transient auth state stays in Durable Objects with optional D1
  fallback/mirror, while core durable data and PII move to a shared external
  PostgreSQL/MySQL database through Hyperdrive or an equivalent database adapter.

Implementation status labels:

- `planned`: design accepted, not implemented.
- `implemented`: code exists for the described behavior.
- `validated`: implementation has passed the required tests/load gates.

Feature status matrix:

| Feature | Initial status |
| --- | --- |
| `shared-d1` profile | `implemented` |
| `tenant-d1` profile | `planned` |
| `tenant-d1` MVP release label | `supported` after MVP gates |
| `tenant-d1` production-ready label | `planned` |
| `shared-d1` -> `tenant-d1` migration execution | `planned` |
| `external-durable` runtime read/write | `planned` |
| tenant DB intra-tenant sharding | `planned` |
| DR/backup lifecycle implementation | `planned` |

Tenant-by-tenant shared/dedicated mixing is out of scope. A deployment chooses one
profile based on expected total scale, operational maturity, and data residency needs.

This is a breaking-change design. Backward-compatible migration from existing shared
tables is not required while the product still has few live users.

## Goals

- Keep a simple product model: one deployment uses one storage profile.
- Preserve the low-latency Cloudflare-native auth path for transient state.
- Provide a large-scale path for 200+ tenants and multi-million user deployments.
- Keep PII and non-PII/core separation explicit.
- Avoid tenant-per-table complexity and avoid mixed shared/dedicated tenant placement
  inside a single deployment.
- Support a Cloudflare-native scale path through `tenant-d1`.
- Keep the schema and adapter contracts ready for `external-durable`.
- Design upgrade paths from `shared-d1` to `tenant-d1` and from `tenant-d1` to
  `external-durable`; migration execution is a later implementation phase.
- Assume a future control DB for global users, tenant discovery, routing metadata, and
  storage profile registry.
- Make audit storage configurable so high-volume deployments do not bottleneck on D1.
- Use existing load-test data to protect known-good auth hot paths.

## Non-Goals

- No per-tenant switching between shared and dedicated storage.
- No tenant-per-table model.
- No requirement to support online migration from the current shared schema.
- No guarantee that shared D1 remains suitable for all durable data beyond small
  deployments.
- No use of Hyperdrive query caching as a correctness dependency for auth or PII.
- No implementation of live dual-write migration in the first storage-profile delivery.

## Storage Classes

### Transient Auth State

Short-lived protocol state whose scale is driven by login rate and TTL rather than total
registered users:

- login challenges and OTP verification state
- authorization codes
- PAR requests
- sessions
- refresh token rotation state
- revocation/JTI state
- Device Flow and CIBA request state
- rate-limit and anti-abuse counters where applicable

Primary storage for transient auth state should remain Durable Objects. D1 may be used
only as a fallback, recovery mirror, or cold index when it does not block the successful
hot path.

Each storage profile declares a `transientAuth` policy:

- `sessionColdPersistence`: `enabled` or `disabled`.
- `sessionClientMirror`: `sync`, `async`, or `disabled`.
- `deviceCibaColdPersistence`: `enabled` or `disabled`.
- `externalDurableMirror`: `disabled` or `future`.

`shared-d1` keeps existing D1 cold persistence enabled. `tenant-d1` and
`external-durable` default session cold persistence to disabled, session-client mirrors
to async, and Device/CIBA cold persistence to disabled until those flows are explicitly
made profile-controlled. External durable transient mirrors remain a future option, not
a first runtime implementation.

Transient auth failure policy:

- Fail closed: Durable Object state transitions that enforce one-time use, revocation,
  logout invalidation, authorization-code replay handling, Device/CIBA approval or denial,
  CIBA token issuance, DPoP/JTI replay protection, and refresh-token rotation.
- Fail open / best effort: D1 or external cold persistence, `session_clients` logout
  tracking mirrors, recovery indexes, audit-style metadata mirrors, and future external
  durable transient mirrors.
- Large profiles may disable fail-open mirrors without changing protocol correctness.

Known exception candidates that need cleanup:

- `session_clients` D1 writes are now mirrors. Token/implicit-hybrid issuance updates the
  `SessionClientStore` Durable Object and only mirrors to D1/external storage according to
  `sessionClientMirror`. Logout reads prefer the DO and use the table only as a compatibility
  fallback when the DO binding is unavailable.
- Device Flow and CIBA cold persistence currently await D1-backed persistence in some
  paths.
- Some critical audit paths may still synchronously write to D1 depending on profile.

### Core Durable Data

Long-lived non-PII source-of-truth data:

- `users_core`
- passkeys
- linked identities
- roles, relationships, ABAC attributes, consents, policies
- SAML/OIDC client and tenant runtime settings when classified as tenant runtime data
- custom non-PII claim values
- token family metadata used for management and revocation UX

Core durable data can stay in shared D1 for `shared-d1`, move to per-tenant D1 for
`tenant-d1`, or move to external PostgreSQL/MySQL for `external-durable`.

### PII Durable Data

Long-lived personally identifiable data:

- `users_pii`
- PII custom claim values
- PII tombstones
- PII-linked identity details
- PII-bearing operational metadata

PII durable data can stay in shared D1 for `shared-d1`, move to per-tenant D1 for
`tenant-d1`, or move to external PostgreSQL/MySQL for `external-durable`.

### Audit Data

Audit logs are not part of the login correctness path. The default D1 audit sink is
acceptable for small deployments, but large deployments must be able to route audit data
to a dedicated sink.

Supported audit sink direction:

- small: D1 hot audit table
- medium/large: Queue or non-blocking writer with archive in R2/external DB
- large regulated deployments: external DB/SIEM export with retention controls

Audit write failures must not take down normal login flows unless the event is explicitly
classified as security-critical and the selected profile requires fail-closed behavior.

Audit event backpressure is profile-driven:

- Built-in audit profiles default to `backpressure.mode = event_class`.
- `backpressure.mode = fail_closed_all` forces every audit event through the strong-delivery
  behavior, including login/token/user activity events that are normally best-effort.
- Tenant-level audit profile overrides may make audit behavior stricter or looser when the
  selected profile allows tenant override.
- Event-category runtime overrides are reserved for a future implementation.
- Unknown/unclassified audit events default to fail-closed or strong retry until they are
  explicitly categorized.

## Storage Profiles

### Profile 1: `shared-d1`

All durable Authrim data uses shared D1 databases, preserving the current Cloudflare-native
operational model.

Recommended use:

- small deployments
- early adopters
- low operational overhead environments
- total user count comfortably below D1 capacity risk

Characteristics:

- `users_core`: D1
- `users_pii`: D1
- transient auth state: Durable Objects with optional D1 fallback/mirror
- audit: D1 by default, configurable
- discovery/control metadata: D1/KV as today

Risks:

- Single D1 database size limit.
- D1 query serialization on a single database.
- Index and table growth with total users.
- Audit and session-client write volume can become a hidden bottleneck.

### Profile 2: `tenant-d1`

Control and discovery metadata remain in a shared control DB, while each tenant has
dedicated D1 databases for core durable data and PII.

Recommended use:

- Cloudflare-native deployments that outgrow shared D1.
- 100-200 tenant deployments where per-tenant isolation is important.
- customers that want low infrastructure cost without external PostgreSQL/MySQL.
- deployments that need a clean upgrade step before `external-durable`.

Characteristics:

- control/discovery DB: shared D1
- tenant core: one D1 database per tenant
- tenant PII: one D1 database per tenant, or a per-tenant PII partition set when needed
- transient auth state: Durable Objects primary; D1 fallback/mirror profile-controlled
- audit: D1 for small/medium, queue/R2 or external sink for high volume

Risks:

- Tenant provisioning requires D1 database creation, schema migration, registry updates,
  and binding/runtime resolution.
- Fleet migrations fan out across all tenant databases.
- Worker binding strategy must be explicit; direct static bindings can become operationally
  noisy as tenant count grows.
- Cross-tenant search/reporting must use the control DB or dedicated indexes, not scans
  across tenant databases.

### Profile 3: `external-durable`

Transient auth state remains Cloudflare-native, while core durable data and PII move to a
shared external PostgreSQL/MySQL database.

Recommended use:

- deployments targeting millions of users
- installations that need mature database scaling, backup, replicas, or operator access
- environments where PII capacity/residency needs exceed D1 comfort
- regional/legal constraints that require an external database placement or operator
  controlled database environment
- large multi-tenant deployments where legal, regional, database-operations, or 10M-class
  scale requirements exceed the comfort zone of `tenant-d1`

Characteristics:

- `users_core`: external PostgreSQL/MySQL
- `users_pii`: external PostgreSQL/MySQL, logically separated from core
- transient auth state: Durable Objects primary; D1 fallback/mirror must be optional
- audit: queue/R2/external sink, not shared D1 hot table
- discovery/control metadata: D1/KV initially acceptable, but must stay small

Runtime setup:

- Provision separate external database targets for core and PII, even when both targets
  point at the same managed PostgreSQL cluster initially.
- Apply the external durable migrations from `migrations/external/postgres/` to the
  corresponding core and PII targets.
- Create Hyperdrive bindings or equivalent adapter bindings named from the runtime profile
  references, for example `HYPERDRIVE_CORE_PRIMARY` for `connectionRef: core-primary` and
  `HYPERDRIVE_PII_PRIMARY` for `connectionRef: pii-primary`.
- Set `DEFAULT_STORAGE_PROFILE_ID=builtin:storage:external-durable` only after core and PII
  bindings resolve and schema validation passes.
- Keep raw DSNs, credentials, TLS material, and customer-managed key references outside
  runtime profiles and outside the control DB.

Health and backup:

- Runtime health checks should call the common storage-profile target health helper for
  `users_core`, `users_pii`, and any configured policy/custom-claim targets.
- Request-time settings APIs should report configuration health; active external DB probes
  should run through scheduled health jobs to avoid adding latency to auth requests.
- Database-native backup, PITR, replicas, and regional failover are operator-owned in the
  first implementation. Authrim provides schema, export/import, manifest, and verification
  tooling, but does not own managed PostgreSQL/MySQL replication.

Risks:

- Hyperdrive/origin database latency and connection behavior must be measured.
- Database schema portability must remain disciplined.
- External DB operations become part of Authrim production operations.
- Query cache must not be relied on for fresh auth/PII correctness.

Legal and regional placement requirements:

- `external-durable` is the primary profile for deployments that must place durable
  data in a specific legal region, customer-controlled database environment, or managed
  database account outside Cloudflare D1.
- Core and PII remain separate logical targets. A deployment may map them to separate
  external databases or clusters when policy requires stricter PII placement than core
  durable data.
- Runtime profiles and control metadata store only stable target identifiers such as
  `connectionRef`, region labels, role, and residency classification. Raw DSNs,
  credentials, and customer-managed key material stay in environment bindings,
  Cloudflare Secrets, Hyperdrive bindings, or an external secret manager.
- The control DB may remain Cloudflare-native initially, but it must not contain raw PII
  or raw external database credentials. If a jurisdiction requires control metadata to
  be regionally bound too, that becomes a deployment constraint for the control DB and
  tenant discovery layer.
- Hyperdrive is a connection layer, not the legal system of record. Residency and backup
  guarantees come from the origin PostgreSQL/MySQL placement, replication policy,
  backups, encryption, and operator procedures.
- Legal/regional placement changes are dangerous storage profile changes. They use the
  storage-profile-change job model, break-glass approval, impact summaries, schema
  validation, and cutover/rollback rules.

## Load-Test Baseline

Existing load-test data supports the current DO-sharded transient auth model:

- Full Mail OTP login reached 100-150 LPS with 100% success using 32 shards.
- Refresh token rotation reached 2,000-3,000 RPS depending on shard count.
- Token exchange reached 2,500 RPS with D1 mostly avoided by cache.
- UserInfo reached 2,000-3,000 RPS, but still showed D1 read/write activity.

The Full Login report also showed substantial D1 query volume at 150 LPS. This means the
current implementation is not D1-free. The next design phase must identify which D1 writes
are required for correctness and which can be moved to Durable Objects, queues, or
non-blocking mirrors.

Reference reports:

- `load-testing/reports/Dec2025/full-login-otp.md`
- `load-testing/reports/Dec2025/refresh-token.md`
- `load-testing/reports/Dec2025/token-exchange.md`
- `load-testing/reports/Dec2025/userinfo.md`

## Runtime Resolution

The existing runtime profile model should become the main selection point.

Required behavior:

- Resolve each logical data class to a storage source.
- Keep tenant context mandatory even in shared databases.
- Prevent tenant-owned durable data from accidentally writing to the wrong source.
- Fail closed if required profile bindings are missing.
- Allow tests to run the same repository contract against D1 and external adapters.
- Use a control DB as the source of truth for tenant discovery, global users, profile
  registry, database registry, and migration state.

Logical source names:

- `control`
- `users_core`
- `users_pii`
- `transient_auth`
- `audit`
- `custom_claims`
- `policy`

## Upgrade Paths

Upgrade paths are required by design, but live migration execution is deferred.

Supported upgrade directions:

- `shared-d1` -> `tenant-d1`
- `tenant-d1` -> `external-durable`

Candidate migration methods:

- offline export/import with maintenance window
- batch copy jobs with validation and cutover
- dual-write to old and new stores during a migration window
- backfill plus read-compare mode before switching reads

The first implementation must keep repository contracts, schema naming, tenant
predicates, IDs, and migration metadata compatible with these future upgrades.

## Operational Guidance

Initial scale guidance:

- `shared-d1` is the default for small installations.
- Start evaluating `tenant-d1` once total registered users enter the high hundreds of
  thousands or when tenant isolation is a selling point.
- Recommend evaluating `tenant-d1` when a deployment approaches 500,000 total users,
  100 tenants, high login rate, or high audit volume.
- Recommend `tenant-d1` more strongly once a deployment approaches 1,000,000 total users
  unless operational constraints favor `external-durable`.
- Prefer `tenant-d1` for Cloudflare-native 200-tenant deployments unless a legal,
  residency, or database-operations requirement points to external storage.
- Start evaluating `external-durable` when D1 limits, global data placement, customer DB
  requirements, or legal/regional constraints exceed the comfort zone of `tenant-d1`.
- Require `external-durable` planning for 10M-class deployments.
- Operators may override the recommendation and explicitly choose a profile, but the
  product should surface warnings when the selected profile does not match expected
  scale, tenant count, login rate, audit volume, or legal/regional requirements.

These thresholds are planning guidance, not hard limits. Actual choice depends on table
size, indexes, audit volume, login rate, retention, and regulatory requirements.

## Specification Questions

### 1. Deployment Storage Profile

Explanation: Decide which storage profile a deployment uses. Mixing small tenants on
shared storage and large tenants on dedicated storage inside one installation adds
runtime and operational complexity.

#### Choice A: `shared-d1` only

Pros:

- Simplest product and operational model.
- Best Cloudflare-native cost profile.
- Matches the already tested implementation most closely.

Cons:

- D1 size and serialization limits become product scale limits.
- 10M-class deployments are high risk.
- Audit and management queries can contend with auth data.

#### Choice B: `tenant-d1` only

Pros:

- Best Cloudflare-native scale path.
- Keeps external infrastructure cost out of the default product.
- Stronger per-tenant isolation than `shared-d1`.

Cons:

- Provisioning and all-tenant migrations become product features.
- Static binding/config management can become noisy.
- Still inherits D1 limits per tenant database.

#### Choice C: Support `shared-d1`, `tenant-d1`, and `external-durable` as deployment profiles

Pros:

- Keeps small deployments simple.
- Gives large deployments both Cloudflare-native and external DB paths.
- Avoids per-tenant mixed mode while still preserving choice.
- Supports legal/regional external DB requirements without forcing every customer there.

Cons:

- Repository contracts and tests must cover all profiles.
- Setup and documentation are larger.
- Some feature behavior must be profile-aware.

#### Choice D: Tenant-by-tenant shared/dedicated mode

Pros:

- Maximum placement flexibility.
- Could optimize cost per tenant.

Cons:

- Complex routing, migrations, support, and debugging.
- Easy to create inconsistent customer behavior.
- Conflicts with the desire to avoid mixed shared/dedicated systems.

Recommendation: Choice C. Support three deployment profiles, but keep one profile per
installation.

### 2. Tenant D1 Provisioning Authority

Explanation: `tenant-d1` requires creating per-tenant D1 databases. D1 databases can be
created by Wrangler, the Cloudflare dashboard, or the Cloudflare REST API. The product
needs to decide whether Authrim itself creates databases or only records databases
created by operators.

#### Choice A: Setup/CLI provisioning only

Pros:

- No Cloudflare API token inside runtime services.
- Simple security story.
- Good first implementation.

Cons:

- Admin UI cannot fully create an active tenant without operator action.
- Less self-service.

#### Choice B: Admin UI calls an operations API that creates D1 databases

Pros:

- Best product experience.
- Tenant creation can be one workflow.
- Enables retries and status in the Admin UI.

Cons:

- Requires a Cloudflare API token with D1 Write permission.
- Needs careful privilege separation and audit.
- Failure recovery must be robust.

#### Choice C: Queue-backed provisioning worker

Pros:

- Keeps privileged Cloudflare API use out of normal request handlers.
- Natural place for retries, migration application, and status updates.
- Good long-term product architecture.

Cons:

- More implementation than CLI-only.
- Requires job observability.

#### Choice D: Manual external provisioning only

Pros:

- Lowest implementation cost.
- Useful for early experiments.

Cons:

- Error-prone.
- Not acceptable as the main product path.

Decision update 2026-05-23: use the preallocated tenant D1 pool as the product path.
Setup tooling creates tenant D1 slots through `wrangler`, deploys generated bindings, and
publishes runtime registry state. Admin UI assigns an available slot and must not store or
use Cloudflare API tokens for tenant D1 provisioning. If capacity is exhausted, operators
expand the pool with setup tooling rather than mutating Cloudflare resources from Admin UI.

### 3. Tenant D1 Runtime Access Strategy

Decision: Use generated D1 bindings managed by provisioning/deploy automation.

Runtime performance should be effectively the same as static bindings as long as request
paths use the D1 Workers Binding API. The difference is operational: static bindings are
hand-managed, while generated bindings make tenant provisioning and later
`external-durable` support easier to model through the same registry/resolver pipeline.

Runtime queries must not use the D1 REST API for auth hot paths. Workers Binding API is the
data-plane path for low-latency queries, and setup/wrangler is the control-plane path for
tenant D1 slot creation and binding deployment.

Selected approach:

- First implementation: generated config/bindings via setup or provisioning tooling.
- Product target: Admin UI creates a provisioning request; provisioning worker/tooling
  creates D1 databases, applies migrations, updates registry, and triggers deployment
  if required.
- Tenant creation starts in `requested` or `provisioning` state and becomes `active`
  after a batch deploy or scheduled deploy window completes.
- Deployments may batch tenant activation and run during configured low-traffic windows.
- Runtime: resolve tenant DB from registry to a configured binding and use the normal D1
  binding API.

### 4. External Durable Core/PII Physical Separation

Decision: Use separate external core and PII databases or separately managed database
targets.

This aligns `external-durable` with the D1 profiles, where core and PII are already
separate logical storage planes. It also makes legal/regional placement easier because
PII can be placed, backed up, retained, and audited independently from core durable data.

Selected approach:

- `users_core`: external core database target.
- `users_pii`: external PII database target.
- shared repository contracts and tenant predicates remain mandatory in both.

### 5. Tenant D1 Core/PII Physical Separation

Decision: Use one tenant core D1 database and one tenant PII D1 database per tenant.

This preserves the same separation model across `shared-d1`, `tenant-d1`, and
`external-durable`. It also keeps later `tenant-d1` -> `external-durable` migration
simple because the source and target both have separate core and PII planes.

Future option: add region-specific tenant PII D1 databases if residency requirements
need Cloudflare-native regional PII placement before moving to `external-durable`.

### 6. Control DB, Tenant Settings, and Policy Placement

Decision: Use the control DB for discovery, global user routing, storage/profile
registry, and migration state. Use KV for runtime delivery/cache of tenant settings and
policy contracts. Keep tenant runtime policy data that needs strong durability, history,
or complex queries in the appropriate durable store.

Selected approach:

- control DB: tenant discovery, database registry, runtime profile registry, global user
  routing/identity mapping minimal records, migration jobs, provisioning status.
- global user routing data uses versioned HMAC/blind-index identifiers, hashed domains,
  and tenant candidate records rather than plaintext identifiers.
- KV: tenant settings, tenant policy contract snapshots, resolved policy cache,
  invalidation/version signals, low-latency runtime configuration.
- tenant durable store: tenant-owned policy rules, relationship/attribute data, consents,
  and records requiring SQL queries or migration with tenant user data.

This keeps control DB small while still allowing fast runtime config reads.

### 7. Upgrade Strategy

Decision: Standardize on batch copy with maintenance cutover first. Design for future
dual-write/read-compare and CDC-style continuous synchronization, but do not implement
those in the first delivery.

Selected approach:

- Standard: batch copy job, validation, cutover, rollback plan.
- Future: dual-write/read-compare for lower downtime.
- Later large-scale option: CDC-style continuous synchronization if deployments require
  near-zero downtime.

### 8. Session-Client Tracking

Decision: Move `session_clients` tracking to a dedicated SessionClient Durable Object.

This avoids adding more responsibility to SessionStore and lets token issuance update
logout tracking without a blocking D1 write. D1 or external durable storage can remain an
asynchronous index/mirror for management, diagnostics, and recovery.

Selected approach:

- token issuance updates `SessionClientStore` DO.
- logout reads `SessionClientStore` DO for authoritative current logout targets, then
  hydrates current logout URI settings from `oauth_clients`.
- D1/external mirror is asynchronous and profile-controlled.
- load tests must compare current D1-backed token issuance with the DO-backed design.

### 9. Transient Auth State D1 Dependency

Explanation: Durable Objects already perform well in load tests, but current code still
uses D1 for fallback, indexes, audit, and logout support. Removing every D1 write may
increase DO/KV/Queue cost and operational complexity.

#### Choice A: Keep current D1 persistence as-is

Pros:

- Lowest implementation cost.
- Preserves fallback behavior.
- Closest to existing load-test baseline.

Cons:

- D1 write volume remains a hidden scale limit.
- Logout/session-client writes can affect token issuance latency.
- Harder to reason about large deployments.

#### Choice B: Remove D1 from all transient auth paths

Pros:

- Cleanest hot path.
- Avoids D1 serialization bottlenecks.
- Makes transient scale mostly a DO sharding problem.

Cons:

- More Durable Object storage and indexing work.
- Recovery and management queries become harder.
- Could raise platform cost if overdone.

#### Choice C: Keep DO primary, make D1 fallback/mirror optional and non-blocking

Pros:

- Protects login hot paths.
- Preserves recovery/index options for small deployments.
- Lets large deployments disable or replace D1 mirrors.

Cons:

- Requires careful classification of critical versus non-critical writes.
- Some logout and recovery behavior must be redesigned.
- Needs load tests for both enabled and disabled mirror modes.

#### Choice D: Move transient auth state to external DB

Pros:

- Centralized operational model.
- Easier SQL-based inspection.

Cons:

- Adds network latency to auth hot paths.
- Loses the current DO-sharding strengths.
- Not aligned with existing successful load tests.

Recommendation: Choice C, with async mirror as the default. Large deployments may disable
the mirror. External durable mirror targets should be supported later, but are not part of
the first implementation.

### 10. Audit Log Sink

Explanation: AuditLog currently defaults to D1 in several paths. At large scale, audit
writes should not contend with auth/user durable data.

#### Choice A: D1 audit only

Pros:

- Simple.
- Easy to query locally.
- Good enough for small deployments.

Cons:

- Can bottleneck large deployments.
- Retention and archive costs are limited by D1.
- Auth and audit compete for the same database class.

#### Choice B: D1 hot table plus R2 archive

Pros:

- Keeps recent query UX simple.
- Moves long-term retention out of D1.
- Lower implementation cost than full external audit service.

Cons:

- Hot audit writes still hit D1.
- Archive query is more complex.
- Not enough if write volume itself is the bottleneck.

#### Choice C: Queue-backed audit sink with D1/R2/external targets

Pros:

- Decouples auth latency from audit write latency.
- Supports different sinks by deployment profile.
- Gives room for retries and backpressure.

Cons:

- Requires queue observability.
- Needs fail-open/fail-closed policy per event class.
- More moving parts.

#### Choice D: External audit/SIEM only

Pros:

- Best fit for regulated large deployments.
- Avoids D1 audit bottlenecks entirely.

Cons:

- Too heavy as the default.
- Requires customer-specific operations.
- Harder local development story.

Recommendation: Choice C. Use D1 as the small-deployment default sink, but route large
deployments through a queue-backed audit pipeline.

Audit fail-closed decision:

- login/token/user activity audit: fail-open with retry/best-effort delivery.
- signing key, admin user, role/permission, policy, security setting, tenant, database,
  storage profile, and provisioning changes: fail-closed or strong retry before success.
- the exact event catalog must be maintained explicitly; severity alone is not enough.

Implementation status:

- The shared event catalog is implemented in `services/audit/event-classification.ts`.
- D1 hot audit tables are profile-controlled. `createAuditLog()` keeps legacy D1 writes for
  D1-primary audit profiles and skips them when the resolved audit profile has no D1 primary.
- High-volume login/logout and refresh-token created/rotated/expired audit are non-blocking or
  batched; refresh-token theft detection and family revocation remain security-critical.
- Audit storage Admin API exposes configuration-level health, retry, and DLQ visibility for the
  selected profile. Active sink probing should be scheduled rather than run on every settings
  request.
- Queue/R2/archive-only profiles are the large-scale direction. Enforcement of blocking
  fail-closed behavior is still a later runtime-policy step.

### 11. External Durable Initial Database Support

Decision: PostgreSQL is the first formally supported external durable database. MySQL
remains a preview target until repository contract tests, migration generation, and load
tests are complete for both.

Selected approach:

- formal: PostgreSQL via Hyperdrive or equivalent adapter.
- preview: MySQL adapter compatibility maintained, but not the first recommended
  production target.
- formalization gate can start light to avoid early external infrastructure cost, but the
  recommended production validation target is repository contracts, migration validation,
  100 LPS login, UserInfo, 1M synthetic users, and audit-heavy benchmark.

External tenant separation and connection management:

- initial external durable layout uses shared tables with mandatory `tenant_id`
  predicates inside separate core and PII database targets.
- future large-scale optimization may use table partitioning by `tenant_id`.
- control DB stores `connectionRef` and storage target metadata only.
- raw connection strings and secrets remain in environment bindings, Cloudflare Secrets,
  Hyperdrive bindings, or an external secret manager.

Profile change authorization:

- initial implementation requires system admin plus break-glass approval.
- future implementation may add two-person approval and/or a dedicated
  provisioning/storage operator role with approval.
- storage profile changes are managed as jobs with states:
  `requested`, `approved`, `preparing`, `validating`, `ready_for_cutover`,
  `cutting_over`, `completed`, `failed`, and `rolled_back`.
- dangerous storage operations require typed confirmation with an impact summary showing
  affected tenants, databases, profile changes, irreversible steps, and expected
  downtime/maintenance windows.
- future Admin UI policy may add two-person approval for dangerous operations.

### 12. Tenant Database Migration Failure Policy

Decision: Track migration success and failure per tenant database.

Selected approach:

- record schema version and migration status per tenant core/PII database.
- failed tenants enter `failed` or `degraded` state for the affected database.
- runtime feature gates must fail closed when a tenant database schema is too old for a
  requested feature.
- migration runner must be resumable and tenant-scoped.

### 13. Tenant Identifiers, Slugs, and Storage Naming

Decision: `tenant_id` is the immutable internal identifier. `tenant_slug` is a mutable
human-facing identifier used for display, URLs, and operator ergonomics where appropriate.

Selected approach:

- `tenant_id`: primary key, database registry key, migration state key, runtime routing
  key, audit tenant key, and stable storage naming input.
- `tenant_slug`: display/admin UX, optional URL or vanity routing helper, generated
  binding readability helper, and operator-facing labels.
- changing `tenant_slug` does not rename D1 databases or binding references.
- storage resources created with an old slug remain valid; registry metadata can keep
  both creation slug and current slug for debug.

Tenant D1 database names:

- `authrim-{env}-{tenant_id}-core`
- `authrim-{env}-{tenant_id}-pii`

Tenant D1 binding names:

- `TDB_{SANITIZED_SLUG}_{SHORT_HASH}_CORE`
- `TDB_{SANITIZED_SLUG}_{SHORT_HASH}_PII`

The short hash is derived from immutable tenant identity data to avoid collisions. If the
slug later changes, existing binding names remain unchanged until an explicit operator
rename/redeploy workflow is introduced.

### 14. Tenant Deletion, Backup, and Purge

Decision: tenant deletion is a job-driven soft-delete workflow with export backup and
scheduled purge.

Selected approach:

- tenant deletion queues an internal job.
- tenant enters disabled/deleting state before data-plane purge.
- export tenant core/PII data to R2 or configured backup destination before purge.
- purge runs after retention and approval conditions are satisfied.
- immediate database deletion is not allowed from normal Admin UI actions.
- job status, backup object references, and purge state are stored in the control DB.
- restore and purge require system admin privileges plus break-glass approval.
- final tenant database purge after retention requires system admin plus break-glass
  confirmation.
- future enterprise policy may require two-person approval for final purge.

### 15. Tenant Database Registry Source of Truth

Decision: the control DB is the source of truth. Generated runtime config/bindings are
derived artifacts.

Selected approach:

- control DB stores tenant database IDs, binding refs, schema versions, provisioning
  state, migration state, backup state, and current resource status.
- generated Wrangler/config artifacts are produced from control DB state.
- runtime resolver validates that configured bindings match active registry entries.
- Wrangler/setup lock state and generated binding state can be used for reconciliation, not as
  the hot-path source of truth.
- tenant database registry primary key is `(tenant_id, role, generation, shard_group,
  shard_index)`.
- MVP uses `shard_group = 'default'` and `shard_index = 0`.
- tenant database registry roles are tenant-owned roles: `tenant_core`, `tenant_pii`,
  `tenant_audit`, and `tenant_custom`. Control DB resources use a separate registry.
- active tenant database selection uses a separate active pointer table. Registry rows
  retain resource history; the pointer table identifies the active generation/shard set.
- active pointer primary key is `(tenant_id, role, shard_group)`.
- active pointer stores `generation`, `shard_count`, and `shard_key_strategy`; resolver
  validates matching registry rows before use.
- registry row status describes resource state, while provisioning/migration/profile
  change progress is tracked in job tables.
- tenant database registry rows include an HMAC signature so runtime/provisioning code can
  detect accidental or unauthorized registry mutation.
- HMAC signature covers security/routing-critical fields: `tenant_id`, `role`,
  `provider`, `database_id`, `binding_ref`, `schema_version`, `status`, `generation`,
  `shard_group`, `shard_index`, `shard_count`, `shard_key_strategy`, `worker_shard`,
  `deployment_target`, `region_hint`, and `jurisdiction`. Non-security metadata and
  timestamps are not part of the signature.
- registry signatures include `key_id`; verification accepts current and previous keys
  during rotation.
- runtime registry snapshots use Ed25519 signatures so runtime verification can use a
  public key without holding the snapshot signing secret.
- Ed25519 snapshot signing private key is held only by provisioning/control worker
  surfaces, not by normal auth hot-path runtime Workers.
- future enterprise deployments may move snapshot signing to an external KMS or signing
  service.
- runtime snapshot verification accepts current and previous public keys during rotation.
- future implementation may expose snapshot verification keys through a JWKS-style key
  set.
- runtime registry snapshot signature failures fail closed for affected tenants, create a
  security audit event, and surface an Admin alert.
- registry signature failure notification uses a common notification channel design rather
  than a storage-profile-specific implementation.
- initial common notification scope covers storage, registry, and security-critical
  events for this storage-profile plan.
- initial notification delivery is internal event table/queue only.
- future notification delivery may add webhook and email providers.
- notification delivery failure is fail-open with retry/dead-letter handling; it does not
  roll back the storage/security operation that produced the notification.
- future tenant/profile policy may choose stricter notification delivery behavior.
- reconciliation runs as a daily scheduled job and also around provisioning/migration
  operations.

Tenant database health checks:

- active tenant databases receive lightweight scheduled health checks.
- lightweight tenant database health checks run every 5 minutes by default.
- deep checks run only when lightweight checks fail, after provisioning/migration, or on
  operator request.
- deep checks compare registry schema version with the tenant database migration table to
  detect schema drift.
- schema drift means the control registry and the actual tenant database disagree about
  applied migrations, schema version, required tables, indexes, or constraints.
- schema drift examples include registry version ahead of DB migration table, core and
  PII databases at different required versions, missing indexes after a partial migration,
  manual schema edits, or a failed migration whose registry state was advanced.
- request-path database failures update health/status metadata without making health
  checks part of every hot path.
- health failure state progresses from healthy to degraded after deep-check failure and
  from degraded to failed after a configurable number of consecutive failures.
- schema drift fails closed when the tenant database is below a feature's minimum schema
  version; otherwise it enters degraded state until repaired.
- runtime behavior for a failed tenant remains fail closed for affected routes.

Runtime resolver failure policy:

- missing registry rows, inactive resources, missing bindings, invalid signatures, or
  schema incompatibility fail closed for the affected tenant.
- resolver failures must not fall back to `shared-d1` or another tenant database.
- affected tenants enter degraded/failed status until operator or job recovery.
- missing active Worker binding fails closed, marks the affected tenant/resource degraded
  or failed, surfaces an Admin alert, and triggers reconciliation.
- schema version mismatch fails closed for features whose minimum schema version is not
  met, surfaces an Admin alert, and requires migration/repair.

Provisioning idempotency and regeneration:

- provisioning idempotency key is `tenant_id + role + generation`.
- database recreation increments generation and creates a new database resource.
- the registry active pointer moves only after the new generation is provisioned,
  migrated, signed, and health-checked.
- older generations are retained for rollback/purge according to lifecycle policy.
- failed provisioning attempts remain as failed generations and retry by creating a new
  generation rather than deleting resources immediately.

### 16. Tenant Schema Version Compatibility

Decision: use feature-level minimum schema versions. Operationally target N-1 version
compatibility during rolling tenant migrations.

Selected approach:

- each tenant core/PII database tracks schema version and migration status.
- runtime features declare minimum required schema versions.
- if a tenant database is too old for a feature, that feature fails closed for the tenant.
- normal operations should support N-1 during migration windows.
- long-lived version drift is not supported.

Tenant isolation verification:

- integration tests must include at least two tenants backed by physically distinct
  tenant core/PII databases.
- runtime repositories retain `tenant_id` predicates and validate tenant mismatch even in
  physically isolated tenant databases.
- routing bugs must fail closed if a row belongs to a different tenant than the active
  tenant context.

### 17. Tenant Audit Placement

Decision: use queue/R2 as the primary large-scale audit direction, with D1 hot tables as
optional profile-controlled query stores.

Selected approach:

- small deployments may keep D1 hot audit tables for recent query UX.
- `tenant-d1` large deployments should route high-volume audit through Queue/R2 and
  optional external sinks.
- audit must not be centralized into the control DB as a high-volume write path.
- Admin UI audit query capability depends on the selected audit profile and available
  hot/archive query backends.
- audit backpressure behavior is tenant/profile configurable between:
  - fail closed for all audit events.
  - event-class-based behavior where fail-open events may use late delivery/best effort
    and critical events use strong retry or fail closed.
- default audit backpressure behavior is event-class-based.
- audit backpressure mode is configurable at the deployment/profile level with tenant
  override support.
- event-category-level overrides are reserved for a future implementation.

### 18. Tenant Backup Encryption and Retention

Decision: tenant exports containing PII use tenant-specific application-level envelope
encryption. Backup retention is tenant/contract configurable with a default of 30 days.

Selected approach:

- each tenant backup uses a tenant-specific data encryption key or envelope key context.
- PII and core exports can have distinct encryption metadata.
- R2 storage encryption is not the only protection layer for PII exports.
- retention default: 30 days.
- retention may be changed per tenant or contract.
- purge jobs must respect retention, legal hold, and approval policy.
- encryption key management is abstracted behind a KMS interface.
- initial implementation may derive tenant backup keys from a deployment master secret,
  but the interface must support external KMS/customer-managed keys later.
- standard consistent exports run in a maintenance/read-only window.
- future low-downtime export can use write-ahead markers plus incremental catch-up.
- tenant backup policy supports deletion-before-purge backup, manual backup, and
  scheduled periodic backup.
- default backup policy includes deletion-before-purge backup and manual backup.
- regulated or enterprise tenant/profile policy may enable scheduled periodic backup.

Tenant export format proposal:

- standard format: JSONL per table with a manifest.
- optional restore format: SQLite/D1 dump for same-profile D1 restore.
- future analytics format: Parquet for large tenant analytics, audit analysis, and data
  lake integration.

The standard JSONL export should include:

- `manifest.json` with profile, tenant, schema version, table list, row counts, chunk
  metadata, checksums, export timestamp, and encryption metadata.
- one or more JSONL chunks per table.
- deterministic table export order and documented restore/import order.
- per-chunk checksum and overall export checksum.
- tenant-specific envelope encryption for PII-bearing chunks.
- export manifest records the export consistency level.
- deletion and migration exports use maintenance/read-only consistency by default.
- scheduled periodic backups may use best-effort online export with explicit consistency
  metadata.
- initial restore dry-run validates manifest and checksums.
- future restore dry-run may restore into a temporary D1/external database to validate
  schema/import compatibility.

This keeps migration and backup portable across `shared-d1`, `tenant-d1`, and
`external-durable`, while still allowing D1 dump and Parquet formats for specialized
restore or analytics needs.

### 19. Dual-Write Migration Source of Truth

Decision: during future dual-write/read-compare migrations, the old database remains the
source of truth until cutover. After cutover, the new database becomes the source of
truth and the old database becomes rollback/fallback material for the retention window.

Selected approach:

- before cutover: old source is authoritative, new source is shadow/backfill target.
- read-compare can sample or fully compare depending on migration profile.
- cutover requires validation thresholds to pass.
- after cutover: new source is authoritative.
- first migration validation uses schema version checks, row counts, and checksum
  sampling. The reusable evaluator is `validateTenantDatabaseMigrationTargets()`, and
  migration jobs persist its result shape in `validation_result_json`.
- future regulated or large migrations may require full checksums for all tables.
- migration write policy is selected per migration method: initial batch-copy migrations
  use maintenance/read-only behavior, while future dual-write migrations may use
  affected-data-class write freeze.

### 20. Cross-Tenant Admin Search

Decision: use control DB indexes for minimum cross-tenant search and add an asynchronous
search index later for broader search.

Selected approach:

- do not fan out live queries across tenant databases for normal admin search.
- control DB stores minimal non-plaintext discovery/routing/search indexes.
- broader search uses async-maintained indexes with explicit freshness semantics.
- PII-bearing cross-tenant search requires separate privacy review.
- tenant discovery candidate indexes are eventually consistent and include freshness
  metadata.
- initial discovery freshness metadata includes `indexed_at`, `source_updated_at`,
  `index_version`, and `key_version`.
- future API/UI may add a computed `freshness_state` such as `fresh`, `stale`, or
  `reindexing`.
- common freshness-delay examples include email address changes, domain changes, external
  subject relinking, HMAC/blind-index key rotation, and async reindex lag.

### 21. Local Development and CI

Decision: local development defaults to shared D1 emulation, while integration/CI includes
multi-D1 coverage for `tenant-d1`.

Selected approach:

- everyday local setup stays lightweight.
- integration tests create or simulate multiple tenant core/PII databases.
- CI must include at least one physically separated tenant DB test path before
  `tenant-d1` is considered supported.

### 22. Global Discovery Indexes

Decision: control DB discovery indexes may include email domain, normalized email, and
external subject identifiers, but only as versioned HMAC/blind indexes. Plaintext PII is
not stored in the control DB discovery index.

Selected approach:

- email domain discovery uses a versioned HMAC/blind index of the normalized domain.
- exact email discovery uses a versioned HMAC/blind index of the normalized email.
- external subject discovery uses a versioned HMAC/blind index of the normalized issuer
  and subject tuple.
- index records return tenant candidates, not a globally authoritative single tenant.
- hash/key version metadata is stored with each index row so rotation and reindex jobs can
  coexist with old records during a controlled transition.
- HMAC/blind-index key rotation reads with the current and previous key version while an
  async reindex job rewrites records to the current key.
- during the rotation window, discovery index writes dual-write current and previous key
  versions to prevent lookup misses.
- after reindex validation succeeds, previous-key index rows are deleted by cleanup job.
- if multiple candidates match, Authrim returns the candidate set and the user,
  application, or configured tenant policy chooses the primary tenant for that flow.

This keeps tenant discovery useful for consortium deployments where the same user can be
valid in multiple member tenants.

### 23. Runtime Config and Policy Cache Authority

Decision: tenant settings and policy snapshots delivered through KV are runtime caches,
not the source of truth.

Selected approach:

- control DB or tenant durable storage is the source of truth depending on the data
  class.
- KV is the runtime delivery and distribution cache for tenant settings, policy
  contract snapshots, resolved policy cache, and invalidation/version signals.
- cache invalidation uses a version or generation key; readers reject or bypass cached
  data when the expected generation does not match.
- direct delete-based invalidation remains allowed for small/simple caches, but versioned
  invalidation is the standard design for settings and policy data.
- cache generation source of truth is stored in the control DB.
- runtime services may read cache generation from KV as a runtime cache/distribution
  layer, but must treat control DB state as authoritative when reconciling or repairing.

### 24. Runtime User Cache Placement and Keys

Decision: user/client/runtime caches can remain in Cloudflare KV plus request-scoped
memory caches, but cache keys must become storage-profile-aware before profile upgrades
are supported.

Current implementation notes:

- `getCachedUser()` in `packages/ar-lib-core/src/utils/kv.ts` uses `USER_CACHE` KV and
  stores a merged Core+PII UserInfo-shaped payload under a tenant-scoped key.
- `getCachedUserCore()` currently reads the configured core database directly and does
  not use KV.
- `CacheRepository` has a separate core-only cache shape and optional in-memory cache,
  but its key model is not the canonical runtime profile cache model.

Selected approach:

- cross-request runtime cache storage remains KV by default.
- request-scoped caches remain Hono/request-local `Map` structures and are not shared
  across requests.
- profile-aware cache keys include tenant identity plus storage profile identity,
  relevant source role, source-role-level generation, and schema/cache key version where
  stale reads could cross a migration boundary.
- existing tenant-scoped keys such as `tenant:{tenant_id}:user:{user_id}` are acceptable
  only within one stable storage generation.
- profile upgrade or database generation changes must invalidate old cache entries by
  source-role-level version/generation rather than relying only on best-effort deletes.
- generation is tracked per logical source role such as `users_core`, `users_pii`,
  `client`, `consent`, or `policy` rather than only deployment-wide or tenant-wide.

This is the main difference from the current tenant-scoped cache model: the cache can
survive a deployment with one storage profile, but it must not let reads from an old
storage generation leak into a new profile after cutover.

### 25. PII Cache Policy

Decision: PII-bearing user cache is profile/tenant configurable. Authrim must support
both encrypted short-TTL PII cache and disabled PII cache.

Current implementation note:

- the current `USER_CACHE` read-through helper stores merged user data that includes PII
  fields such as email, name, phone number, address, birthdate, profile, and website.

Selected approach:

- supported mode B: encrypted short-TTL PII cache, for deployments that value UserInfo
  latency and accept encrypted PII in KV.
- supported mode C: no PII in cross-request cache; cache only core/non-PII data and read
  PII from the configured PII durable store when needed.
- encrypted PII cache uses tenant-scoped envelope encryption so cache encryption can align
  with tenant isolation, backup encryption, and future KMS/customer-managed-key support.
- `external-durable` and regulated deployments should default to mode C unless explicitly
  configured otherwise.
- `shared-d1` and `tenant-d1` may enable mode B with short TTL, tenant/profile policy,
  and explicit documentation.
- request-scoped PII caching within a single request is allowed when it does not persist
  beyond the request lifecycle.

PII cache modes:

- `encrypted-short-ttl`: tenant-scoped envelope encryption plus short TTL.
- `disabled`: no PII in cross-request cache; PII is read from the configured PII durable
  store when needed.

Default PII cache behavior:

- default mode is `encrypted-short-ttl` for all profiles.
- regulated deployments, tenant policy, or explicit operator configuration may force
  `disabled`.
- the product must make the selected PII cache mode visible in setup/admin surfaces.

### 26. DR Bundle Boundary

Decision: Authrim DR bundles contain control metadata, tenant registry, profile config,
tenant data export references, and checksums. Tenant durable data itself stays in the
referenced encrypted exports or external database backups.

Selected approach:

- include control metadata needed to restore tenant routing and storage profile state.
- include tenant database registry entries, generations, schema versions, and signatures.
- include profile configuration and storage target metadata without raw secrets.
- include tenant export object references, manifest checksums, and backup encryption
  metadata.
- exclude raw exported tenant data from the small DR metadata bundle.
- after DR restore, tenants enter `restored-pending` operational state, represented in
  registry rows as `restored_pending`, and become active only after registry signature,
  health, schema, and export-reference verification passes.
- DR restore may bulk-activate only tenants that have passed verification.
- future DR restore may activate tenants by configured priority group.

For `external-durable`, Authrim provides schema, export, import, and verification tooling.
External database replication, regional failover, and database-native backup operations
remain operator responsibilities.

Future provider-specific plugins may integrate with managed PostgreSQL/MySQL backup and
restore APIs, but the first implementation does not own database-native backups.

### 27. Control DB Runtime Dependency

Decision: control DB is the source of truth, while KV/runtime cache is mandatory for hot
runtime distribution.

Selected approach:

- control DB stores authoritative tenant routing, database registry, profile registry,
  source-role generation, provisioning state, and migration state.
- runtime services read a KV-distributed registry/generation snapshot on hot paths.
- default runtime registry snapshot TTL is 30 minutes.
- runtime services check a lightweight generation key with a default TTL of 60 seconds.
- runtime registry snapshots are tenant-scoped in the first implementation, with a future
  deployment-target-scoped snapshot option reserved for Worker shard deployments.
- snapshot reads should be minimized through Worker memory cache and request-local cache
  because KV reads/writes are not free at high scale.
- snapshots contain normalized runtime data shaped like `ResolvedTenantStore` plus minimal
  debug metadata, not raw full registry rows.
- normal early cutover/rollback reflection uses generation bump, not emergency purge.
- emergency registry purge exists only as a break-glass operation with audit logging.
- control DB reads are allowed for reconciliation, repair, provisioning, admin
  operations, and cache miss/fallback paths, but must not become a normal per-request
  auth hot-path dependency.
- registry/generation snapshots include version and signature metadata so stale or
  tampered runtime cache entries can fail closed.
- if the runtime registry snapshot is within TTL and signature validation passes, runtime
  services may use it even when control DB is temporarily unavailable.
- expired snapshots, missing snapshots, or invalid signatures fail closed for affected
  tenants instead of routing to a fallback tenant database.
- emergency registry purge requires system admin privilege plus break-glass confirmation.

Active pointer cutover:

- control DB transaction updates active pointer and generation source-of-truth together.
- snapshot publish runs as an idempotent job after the control DB transaction.
- if snapshot publish fails, the pointer remains advanced, the publish job retries, and
  the tenant/resource enters `degraded_pending_snapshot`.
- runtime may continue using a valid in-TTL old snapshot until generation mismatch or
  expiration forces refresh.

Resolver error catalog:

- resolver errors use a shared enum plus PII-free structured metadata.
- initial enum includes `missing_snapshot`, `expired_snapshot`,
  `invalid_snapshot_signature`, `missing_active_pointer`, `missing_binding`,
  `schema_version_too_old`, `unsupported_storage_profile`, and
  `tenant_assigned_to_other_deployment_target`.

### 28. Core and PII Cross-Write Failure Policy

Decision: use core-first writes with explicit `pii_status` compensation/retry state.

Selected approach:

- user creation creates core durable state first.
- PII write success moves `pii_status` to `active`.
- PII write failure records `pii_status = failed` or equivalent retryable state without
  hiding the partial state.
- retry/repair jobs reconcile users with missing or failed PII records.
- Admin/API surfaces must expose enough state to avoid treating partial PII records as
  fully healthy users.
- standard auth behavior for `pii_status = failed` allows login when core durable state is
  valid, but token/UserInfo issuance fails when the requested scopes or claims require PII.
- future tenant policy may choose stricter or looser behavior for partial PII state.
- distributed transactions across core and PII stores are not required for the first
  implementation.
- `external-durable` follows the same compensation model and does not rely on cross-plane
  transactions even if an operator places core and PII targets in the same database
  system.

### 29. Tenant Database Migration Concurrency

Decision: tenant database migrations use fixed, configurable concurrency first, with an
adaptive strategy reserved for later.

Selected approach:

- migration runners process tenant databases with a configurable concurrency limit.
- concurrency can be set by deployment/profile/operator config.
- migration jobs support stop, resume, failed-tenant skip, and per-tenant retry.
- migration jobs run canary tenants first; remaining tenants proceed only after canary
  validation succeeds.
- canary tenants are selected by the operator with system-recommended candidates based on
  size, data shape, and risk signals.
- failed tenant databases are marked `failed` or `degraded` without stopping unrelated
  already-completed tenants.
- failed tenant migrations do not automatically roll back. Operators choose resume,
  rollback, or repair after reviewing migration status and audit records.
- future adaptive concurrency may consider tenant size, profile, destination database
  capacity, and observed latency/error rate.

### 30. Tenant D1 Binding Scale Escape Hatch

Decision: start with one Worker carrying generated tenant D1 bindings, but keep a registry
escape hatch for future tenant shard Workers or deployment targets.

Selected approach:

- initial `tenant-d1` may bind all active tenant core/PII D1 databases to one Worker
  deployment when platform limits and operational limits allow it.
- setup/provisioning emits a warning when generated tenant DB binding count crosses a
  configurable threshold.
- initial generated tenant DB binding warning threshold is 3,000 bindings per Worker
  script.
- initial generated tenant DB binding strong warning threshold is 4,000 bindings per
  Worker script.
- Worker shard split is not automatic. Operators decide after strong warning, with a
  future operator-driven shard split job path reserved.
- MVP binds all tenant core/PII D1 databases to all runtime Workers that participate in
  tenant-owned durable data access.
- package role requirement manifests are reserved as a future optimization if binding
  count approaches warning thresholds.
- tenant database registry includes optional `worker_shard` or `deployment_target`
  metadata even if the first implementation leaves it unset.
- runtime resolution must be able to fail closed when a tenant is assigned to a different
  deployment target than the current Worker.
- if binding count or config size approaches practical limits, tenant DB bindings can be
  split across shard Workers without changing tenant database identity.

### 30.1 Tenant-D1 Intra-Tenant Sharding

Decision: initial `tenant-d1` uses one core D1 and one PII D1 per tenant, but the registry
reserves fields for future intra-tenant D1 sharding.

Selected approach:

- MVP does not implement multiple core/PII D1 databases for one tenant.
- tenant database registry reserves `shard_group`, `shard_index`, `shard_count`, and
  `shard_key_strategy`.
- initial reserved shard key strategy is `hash_user_id`.
- future shard key strategies may include Durable Object region-shard affinity or
  explicit regional placement.
- one-region-one-DB placement is allowed as a future strategy when D1 regional latency or
  tenant locality makes it preferable.
- initial operational warnings use approximate thresholds such as 70% storage or 700,000
  accounts for warning, and 80% storage or 800,000 accounts for strong warning.
- tenant size and storage warning inputs are collected by a scheduled stats job into the
  control DB; write-path counters may be added later as an auxiliary signal.
- initial tenant stats frequency is daily. Future policy may increase frequency for large
  tenants or specific profiles.
- tenant stats are stale after 36 hours in the first implementation. Future policy may use
  tenant size or profile-specific stale thresholds.
- stale or failed tenant stats jobs surface stale status in Admin UI and create internal
  notification events. Future external webhook/email delivery can use the common
  notification channel.
- account count warning uses all non-purged users. Active users and active+pending users
  are dashboard/supporting metrics.
- storage percentage is based on D1 API file size first; table-size estimates and
  row-count estimates are diagnostic aids only.
- when D1 file size cannot be fetched, storage warning evaluation uses the last known file
  size with stale status. Row-count-based estimates may be shown as diagnostics.
- tenant size/storage warnings surface in Admin UI and create internal notification
  events. Future external webhook/email delivery can use the common notification channel.
- initial warnings do not create recommended action jobs automatically. Future Admin UI
  may provide an operator-driven path to create shard/profile-change jobs from warnings.
- future warning policy may include query latency, write contention, migration duration,
  and regional access patterns.
- shard-aware backup/export is reserved for future sharded tenants. The future format uses
  a tenant-level manifest plus per-shard manifests.
- future user creation shard policy may choose between `hash_user_id` and
  `region_affinity`; initial reserved behavior is `hash_user_id`.
- region-affinity user movement is not automatic. Future operator/job-driven user shard
  movement may be added; initial behavior keeps users on their assigned shard.
- sharded tenant cross-shard lookup uses control DB discovery indexes with shard hints.
  Runtime fan-out across shards is not used for normal lookup. Fallback fan-out is
  reserved for operator repair tools only.

### 32. Tenant-D1 MVP Runtime Scope

Decision: the `tenant-d1` MVP covers all runtime packages rather than only a subset of
auth/token/userinfo paths.

Selected approach:

- every runtime package that reads or writes tenant-owned durable data must resolve the
  correct tenant core/PII source through the profile-aware resolver.
- unsupported tenant-owned durable paths must not silently fall back to `shared-d1`.
- unsupported tenant-owned durable paths fail closed with `unsupported_storage_profile`.
- unsupported storage profile detection uses both runtime boundary policy tests and
  tenant-d1 route/integration tests.
- tenant-d1 MVP completion requires package unit tests and integration smoke coverage for
  each runtime package that touches tenant-owned durable data.
- security, user, and admin critical endpoints must not be unsupported in the tenant-d1
  MVP.
- non-critical unsupported endpoints require an explicit unsupported endpoint/capability
  list. The final target is no unsupported tenant-d1 endpoints.
- `unsupported_storage_profile` responses use HTTP 409 with structured fields:
  `error`, `storage_profile`, `route`, and `tenant_id`; PII must not be included.
- Admin UI surfaces unsupported capabilities in health/status views and also displays
  runtime errors on affected screens.
- full-package coverage is required before `tenant-d1` is considered implemented.

### 32.1 Tenant-D1 Binding Deployment

Decision: generated D1 bindings are reflected by an Admin UI/provisioning-worker
workflow, not by manual-only CLI deployment.

Selected approach:

- Admin UI creates a provisioning/deployment request.
- a dedicated provisioning worker generates binding/config changes, validates the impact,
  and performs the deployment.
- dangerous deploy-affecting operations still require typed confirmation and impact
  summary.
- CLI/manual deployment remains an operator fallback, not the primary product workflow.

### 33. Tenant DB Registry Resolver Cache

Decision: use Worker memory cache plus request-local cache, controlled by the lightweight
generation key.

Selected approach:

- request-local cache removes duplicate resolver work inside one request.
- Worker memory cache reduces cross-request KV reads and resolver latency.
- the lightweight generation key, with a default TTL of 60 seconds, controls staleness.
- generation mismatch invalidates Worker memory cache and forces a fresh KV snapshot read.

Resolver return shape:

- resolver returns a `ResolvedTenantStore` object rather than a raw binding.
- `ResolvedTenantStore` includes `source`, `role`, `tenant_id`, `generation`,
  `schema_version`, `shard_group`, `shard_index`, `shard_count`, `shard_key_strategy`,
  `driver`, `binding_ref` or `connection_ref`, `deployment_target`, and health/status
  metadata.
- repository factories consume `ResolvedTenantStore`; resolver does not directly own
  repository construction.

### 34. Setup CLI Tenant D1 Provisioning Permissions

Decision update 2026-05-23: setup/provisioning uses setup tool commands backed by `wrangler`,
not Authrim-managed Cloudflare API calls.

Selected approach:

- operators authenticate wrangler outside Authrim.
- setup tool runs `wrangler d1 create/list/execute`, generates bindings, deploys Workers, and
  publishes runtime registry data.
- Authrim runtime, Admin UI, and ar-management must not store Cloudflare API tokens for tenant
  D1 provisioning.
- manual pre-provisioning remains possible as an escape hatch, but it is not the primary MVP
  workflow.

Provisioning activation semantics:

- Creating tenant core/PII D1 databases and writing `tenant_database_registry` rows does not
  guarantee immediate runtime activation.
- `tenant-db` defaults to creating a `ready` generation only. Operators must pass `--activate`
  or use a later operator/admin activation flow to move `tenant_database_active_pointers`.
- Runtime Workers must also have the generated `TDB_*` bindings deployed before activation can
  be used safely. Missing bindings fail closed and surface storage registry alerts.
- Failed provisioning attempts are preserved as failed generations. Retrying should create a new
  generation rather than reusing or mutating the failed generation in place.

Admin UI provisioning request/status flow:

- Admin UI must not create Cloudflare D1 databases directly from the browser. It creates or
  displays an admin job request and shows the exact operator/deployment actions required.
- Initial UI flow:
  1. Operator selects tenant, target generation, and whether activation should be immediate or
     scheduled.
  2. UI shows impact validation: generated `TDB_*` bindings, projected binding count, affected
     runtime packages, and whether a setup-tool deployment is required before activation.
  3. UI creates a `tenant-database/provision` or `tenant-database/profile-change` job in
     `requested`/`pending` state, or shows the equivalent setup CLI command for manual execution.
  4. Status view reads `admin_jobs`, `tenant_database_registry`,
     `tenant_database_active_pointers`, reconciliation alerts, and health/stats summaries.
  5. Activation controls are disabled until registry rows are `ready`, required generated Worker
     bindings are deployed, signatures validate when configured, and health/schema checks pass.
- Batch activation after deploy uses one operator action over a set of ready tenant generations.
  The action updates active pointers only after impact validation and records one job result with
  per-tenant success/failure details.
- Scheduled deploy windows are represented as job metadata (`scheduled_for`, `window_name`, and
  `activation_batch_id`) first. Execution can remain operator-triggered until a scheduler-safe
  deploy/activation runner exists.

Tenant-d1 MVP runtime package boundary:

- A runtime package is considered covered for the tenant-d1 MVP when tenant-owned durable user
  data is either routed through the profile-aware resolver or the route/job is explicitly blocked
  with `unsupported_storage_profile`.
- Routed surfaces:
  - `ar-auth`, `ar-token`, and `ar-userinfo` use request-context runtime sources through
    `createAuthContextFromHono()` / `createPIIContextFromHono()`.
  - `ar-saml`, `ar-bridge`, and `ar-vc` use `resolveUserStoreRuntimeSourcesFromEnv()` for
    direct runtime user-store access.
  - `ar-policy` uses the profile-aware policy logical source, defaulting to tenant core for
    tenant-d1.
  - `ar-management` tenant-scoped request handlers use request-context runtime sources where
    they access user core/PII data.
- Blocked MVP gaps:
  - Device Flow and CIBA cold persistence routes return `unsupported_storage_profile` until their
    D1 cold mirrors are profile-controlled.
  - Admin user import and bulk update job creation routes return `unsupported_storage_profile`
    until those background processors are tenant DB routed.
- Admin provisioning/request flow:
  - Tenant database provisioning and activation batch job routes are control-plane storage
    operations. They may use the deployment/control DB path under `tenant-d1` because the target
    tenant DB bindings may not exist yet.
  - The first Admin UI implementation creates typed admin job requests and surfaces status. Actual
    D1 creation, generated binding/config changes, and Worker deployment execution remain
    setup/operator-driven until the provisioning worker runner is implemented.
- Silent fallback to shared D1 is not allowed for tenant-d1 user core/PII resolver failures. A
  missing registry row, missing generated Worker binding, invalid signature, inactive row, or
  schema-version gate must fail closed and surface a storage registry alert.

### 31. PII Cache Key Management

Decision: use tenant-specific cache encryption key material/context distinct from backup
encryption key material/context.

Selected approach:

- KMS/envelope interface is shared across backup and cache encryption, but key purpose is
  separated.
- cache encryption uses a tenant-scoped `cache` purpose/context.
- backup encryption uses a tenant-scoped `backup` purpose/context.
- key metadata records purpose, tenant, version, algorithm, and rotation state.
- cache key rotation can invalidate or re-encrypt cache entries; backup key rotation uses
  backup-specific lifecycle policy.
