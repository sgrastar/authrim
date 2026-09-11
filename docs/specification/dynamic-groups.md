# Service dynamic groups

Status: initial implementation; integration limits and verification evidence are listed below. No RBAC, ABAC, ReBAC, token or UserInfo integration.

## Existing implementation and reuse

SCIM Groups currently write `roles` and `user_roles`. Their authorization semantics must remain
unchanged. A service group may explicitly link a tenant-local SCIM role ID; this is a read-only
membership source, not a migration. Existing canonical `groups` and `group_memberships` have a
separate identity contract (including timed memberships); they are not implicitly reinterpreted.
The new catalog uses stable IDs, tenant-unique keys, display names and descriptions.

Reuse DatabaseAdapter, signed tenant/account runtime routing, custom-claim schemas and their
existing write permissions, and the Management maintenance scheduler. Do not reuse the legacy
role-rule evaluator: it does not provide three-valued negation or a validated dependency graph.
Do not use the custom-data fetcher's error swallowing for authorization-adjacent calculations.

## Conditions

Expressions are `all`, `any`, `not`, `attribute`, or `member`. References identify groups by stable
ID within the same tenant. A rule references only the evaluated user's saved fields and memberships.
No external calls, code, aggregates, other subjects, relationship traversal or current-time operators.
An absent rule means no dynamic contribution, not an unconditional match.

Truth values are true, false and unknown. Missing, null, invalid types, unreadable fields and broken
external references are unknown. NOT unknown is unknown; AND is false if any operand is false,
otherwise unknown if any is unknown; OR is true if any operand is true, otherwise unknown if any
is unknown. Only true adds a dynamic membership. Unknown is never converted to false before NOT.
Infrastructure read failures prevent snapshot publication, preserving the prior result as stale.

Scalar types: string, number (finite), boolean. Multi-valued custom fields support contains only.
No coercion between types. String equality is case-sensitive NFC; domain equality is lowercase,
country codes uppercase ISO-style two ASCII letters. Email preserves the local part and lowercases
the domain; it is available only when the primary email is verified. Numbers compare numerically.
`eq`, `in` work for scalar types; `lt`, `lte`, `gt`, `gte` for numbers; `contains` for scalar arrays.
No missing/null predicates are exposed in v1. Registration state is guest or registered.
Registration parameters must be registered custom-claim fields and written by the existing validated
registration field path. Arbitrary request parameters are neither stored nor read by this feature.
Schema identity, version, storage class and cardinality form the field contract; schema drift blocks
publication until the rules are validated again. Raw attribute values must not be stored in Core
snapshots or diagnostic logs. Explanations identify rule nodes, configured comparison values and
truth results; they do not disclose the user’s actual input values.

## Compilation and incremental evaluation

At most 256 groups per tenant, 128 expression nodes per group, expression depth 12, dependency
chain depth 16, 32 distinct group references per group, 128 distinct fields, 64 KiB per expression.
Reject self-reference, missing/disabled targets and cycles at save time. Reject deletion or disabling
of a referenced group. Preserve references as a DAG, hash-cons common expression nodes, and persist
attribute and group dependency indexes plus a topological evaluation order.
Evaluate affected nodes against one input snapshot; changed results propagate in topological order.
Every directly changed field/source is seeded before traversal so a stable branch never suppresses
another affected branch. An independent recursive full evaluator serves as the test oracle.

## Sources and publication

Sources are manual, explicit legacy SCIM link, and dynamic. Membership is their union. Removing a
dynamic contribution never removes another source. No exclusion or timed manual membership in v1.
Groups do not inherit permissions or visual hierarchy from their dependency references.

Catalog edits use optimistic concurrency and immutable rule revisions. A new revision becomes desired
immediately. Each subject's entire result is atomically replaced, never one group at a time. During
rollout, reads return the last committed result and its rule/input versions with stale status. A missing
snapshot is pending, never an authoritative empty membership. Future authorization consumers must
check freshness; this change does not connect those consumers.

Core and PII input revision counters are independent, transaction-local change markers. Workers read
both revisions around input acquisition and before publication. Concurrent evaluators use fenced
leases and compare-and-swap; duplicated/reordered notifications request evaluation of current state,
not application of old payloads. Reads compare the committed input vector and catalog revision with
current primary reads. There is no cross-database transaction or claim of linearizable fleet-wide
switching. Bounded durable scans reconcile changes and rule revisions, with persisted cursors and
failure/retry state. Diagnostics and membership changes are recorded atomically with publication.

## Delivery checklist

The final implementation report must enumerate tested writer paths, database backends, runtime
routing modes, scheduler behavior, UI checks and unresolved limitations. This document is not evidence
that a route or feature is connected; connection and failure tests are required.

## Implemented entry points and reconciliation

The shared condition evaluator is called by the Management subject reconcile endpoint and by the
interactive-job maintenance schedule. User writers do not evaluate expressions or enqueue attribute
payloads. Transactional database triggers invalidate subject versions, so dropped, duplicated or
reordered event delivery does not lose the saved change. Routine reads expose staleness immediately;
background convergence requires the Management scheduler and signed account routing to be available.
The group scheduler uses its own tenant cursor, independent of webhook delivery failures.

| Writer                                                              | Connection in this change                                                                                 | Scope of the guarantee                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical user creation/profile/email verification                  | `CanonicalRuntimeUserWriter` write boundary plus Core/PII triggers                                        | One complete writer operation; unpublished accounts are not evaluated                                                                     |
| Registration custom fields (email-code, passkey, TOTP, direct auth) | Existing registration field validation calls the shared `persistCustomClaimWrite`                         | One validated saved custom-field write; no arbitrary request parameter capture                                                            |
| Management user update                                              | Account-specific routing plus an outer boundary over custom fields, lifecycle and canonical profile       | Combined fields in that update are fenced together                                                                                        |
| SCIM user PUT/PATCH and Bulk PUT/PATCH                              | Outer boundary over identifier, custom-field and canonical updates                                        | Combined user update is fenced; existing SCIM account creation remains unpublished until its durable directory operation completes        |
| SCIM Groups                                                         | Triggers on the existing `user_roles` and `roles`, explicit group-to-role link                            | Existing SCIM role semantics and data are preserved                                                                                       |
| CSV row creation/update                                             | Outer row boundary plus shared canonical/custom-field writers                                             | New rows use the durable publication producer; pending rows resume without advancing progress; updates resolve the verified account shard |
| Guest-to-registered transition                                      | Existing atomic `GuestLifecycleRepository.completeUpgrade` account update triggers the Core input counter | Registered state is taken only from the saved account, never public `user_type`                                                           |
| Manual service memberships                                          | Tenant/user/group-scoped source row and audit                                                             | Only manual contribution is changed                                                                                                       |

A schedule page inspects at most 20 users per assigned shard (8 tenants and 32 shards per tenant in
current maintenance discovery). Expression recomputation is skipped for fresh users. Large estates
need multiple schedule invocations; there is no fixed convergence-time promise. Each shard persists
its cursor, rule revision, processed count, failure count and fenced lease. Rule changes reset the
scan; restart invalidates prior scan ownership. Failed subjects remain stale/failed and are retried
on a subsequent sweep. The member API pages over **evaluated subjects**, so an empty page may still
have a next cursor. It does not represent a completed full-directory member count during rollout.

## Recovery and internal consumption

`DynamicGroupStore.snapshot(userId, reader)` is the internal consumer contract: tenant, subject,
rule revision, Core/PII/metadata input counters, metadata epoch, opaque routing generation,
generation, evaluation time and freshness accompany the entire committed evaluation. Production
callers obtain the reader through signed tenant/account routing (`serviceGroupRuntime`); the store
rejects a reader for a different tenant or subject. Only `fresh` results should be used by later
consumers. Freshness means checked primary inputs, not a transaction spanning separate databases.
Routing is verified again while evaluating; counters from different routing generations are not
compared as if they belonged to the same shard. No consumer is connected to authorization here.

Write boundaries remain present across a failed cross-database write. The subject API displays
outstanding boundary IDs and statuses. After reviewing and repairing the saved account attributes,
an operator can explicitly accept the current attributes via the recovery endpoint/UI. This records
an audit entry before removing selected **failed** boundaries and reevaluating. It does not roll back
or rerun the original write. A crashed `writing` boundary never expires automatically and cannot be
cleared by this endpoint; operator investigation and storage-level recovery are required. This is a
fail-closed availability limitation, not permission to infer successful completion after a timeout.

Rule revisions retain actor identity and the compiled rule; membership/manual/recovery records retain
subject, revision and decision/source changes in `service_group_audit`. Raw user attribute values are
not retained in those decision records. These records are separate from existing login and token
events; this change does not add new webhook payloads or token claims.

## Explicit limits and remaining integration work

- CSV normalizes header names and typed cell values before schema validation; it does not yet provide
  arbitrary column-mapping configuration. Group conditions read only the resulting saved fields.
  New-account placement/publication uses the existing D1/Control producer; no fallback writes into
  tenant metadata storage are permitted. PostgreSQL account provisioning is not added by this change.
- Registration spans multiple requests (for example creating an account and subsequently proving
  control of an email). Each committed step is a legitimate new input version, not a single global
  registration transaction. Email-code requests with custom fields and direct email verification
  now fence email verification and custom fields together; those writes are awaited rather than
  letting a background email update escape the input boundary. Passkey/TOTP credential activation
  itself is not a condition input; saved custom fields use the common write boundary.
- Legacy-only `users_core`/`users_pii` writes, canonical non-service-account groups, unsaved registration
  parameters, external API data, arbitrary ABAC attribute stores, and relationship traversal are not
  input sources. Unpublished, inactive, deleted or unroutable accounts fail closed instead of being
  silently reinterpreted as a fresh empty membership.
- The initial reconciler scans subject input versions in bounded pages; it is not a changed-subject
  queue or generic IVM system. Full-fleet throughput/latency and external PostgreSQL deployment have
  not been load-tested. The field picker loads up to 1,000 active schemas; a compiled plan uses at
  most 128 fields and the serialized tenant catalog is limited to 512 KiB.
- This is an additive development schema change. Apply Core and PII migrations before schema-dependent
  Workers. No baseline, finalized release delta, published migration or product version is rewritten.

## Verification evidence

- Independent recursive full-recomputation oracle vs incremental results across 144 successive input
  combinations (including missing, null, malformed and normalized values), branching/merging, NOT,
  multiple changed fields, source overlap and stable-path pruning.
- 14 evaluator tests: 92.93% line coverage, 83.4% branch coverage under V8.
- 13 SQLite integration/API tests: atomic whole-subject snapshots, stale inputs, catalog conflicts,
  superseded leases, route-generation changes, source preservation, missing SCIM references, tenant
  isolation, failed-write recovery, registration-state triggers, real canonical registration/email verification writes and paged failure/resume.
- Chromium dev-mock UI test: AND/group-reference editing, validation/preview, saving/reopening,
  membership explanation, desktop/mobile captures and axe serious/critical checks scoped to the new
  page. Existing shared-header accessibility findings are outside that scoped test.
- Existing writer, custom-claim, Admin and SCIM suites are regression evidence, not proof of an
  end-to-end production registration/import route. PostgreSQL execution and live fleet routing must
  be reported separately from SQLite and mocked-browser coverage.

Final workspace checks: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, OpenAPI validation/route
coverage and draft-manifest verification passed. Admin UI production build and dev-mock guard passed.
The earlier full workspace run was blocked by an unavailable Docker daemon. See the verification
follow-up below for the PostgreSQL execution performed after Docker was restarted. No live
environment was migrated or deployed.

## CSV and registration continuation

CSV row identity is derived from tenant, immutable import job ID and row number. Its durable account
creation operation is checked before duplicate-email handling, so resuming a pending row cannot
misclassify its own created account as a duplicate. The account creation producer pins the normalized
request hash, allocates Core/PII storage, writes canonical/profile and validated custom fields while
group readers are fenced, and only then publishes the directory entry. Pending publication leaves
processed/succeeded counts unchanged, records `directory_pending`, and resumes the same row on the
next worker invocation. Permanent row errors retain the existing failed-row reporting behavior.
Existing-account updates use signed exact lookup and the returned account storage bindings.

Four additional CSV tests cover normalized input ordering, storage placement, pending/resume identity,
validation-only behavior and ambiguous lookup rejection. Email/direct-auth regressions cover awaiting
verification persistence before issuing the completion artifact; the optional-write failure login
behavior is preserved while failed group input boundaries remain fail-closed.

Continuation verification: Auth package 1,399 tests passed (14 skipped), Management package 4,513
passed, and workspace typecheck/lint/format checks passed. OpenAPI and the unchanged draft migration
manifest validated. No live database migration or deployment was performed during this continuation.

## Implementation and UI follow-up

Docker-backed PostgreSQL 17 verification now applies the Core and PII migration chains to isolated
empty databases, checks input revision triggers for manual memberships and sensitive attribute
insert/update/delete, checks tenant isolation and verifies rollback does not advance the input
revision. This found that the PostgreSQL baseline lacked the D1 legacy `user_roles` table. The new
Core migration adds its matching table and index before installing group triggers; existing
`role_assignments` are not converted or reinterpreted. Baselines and finalized deltas are unchanged.
This is migration/trigger evidence, not a production PostgreSQL account-provisioning test.

The member listing now retains an unroutable subject's committed membership with **failed** freshness
instead of failing the entire page. A regression test covers this behavior. Condition explanations
include the configured comparison/value and child node IDs; actual user attribute values are not
included. The SQLite integration/API suite now has 14 tests.

Admin UI offers group search, common condition templates, localized attribute/operator/source labels,
line-separated comparison candidates, a collapsed SCIM section, save confirmation, clearer freshness
and progress guidance, and tables that wrap on narrow screens. AND/OR switching preserves children.
A blank numeric input remains invalid rather than becoming zero. The Chromium regression verifies
switching operators, multiple candidate values, saved group references and comparison explanations,
with serious/critical axe checks on the new page and desktop/mobile captures. Subject inspection
still requires a user ID; no directory picker is added in this iteration.

Final follow-up verification passed: full `pnpm test` (46 Turbo tasks plus Control-plane,
conformance, integration, security-matrix and scale-out suites), workspace typecheck/lint/format,
OpenAPI validation and route coverage, draft manifest checks, Admin UI production build and
production dev-mock guard. Management: 4,514 tests; Setup: 2,528 tests. The final UI-specific
Svelte check reported zero errors/warnings and Chromium/axe passed. No live environment was changed.
