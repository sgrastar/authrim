# Phase 1: Scale-out correctness test plan

## 1. Purpose

Verify that continuous account creation for one tenant can cross repeated shard-capacity boundaries
without operator intervention. The test must observe the complete sequence:

1. account capacity approaches the configured low-watermark;
2. background D1 provisioning starts;
3. the new D1 is created, migrated, bound, smoke-checked, and activated;
4. later accounts are assigned to the new shard;
5. account creation continues without loss or duplication.

The same run also verifies predictive scale-out of the physical Lookup D1 fleet. Successful route
publications must produce a durable growth forecast, capacity must be requested before the configured
headroom is exhausted, and at least one later virtual-bucket cutover must place new routes on each
Lookup shard counted by the assignment-transition acceptance criterion.

This is a correctness test, not a maximum-throughput benchmark.

## 2. Scope

### Included

- One disposable environment.
- One mixed-placement environment with separate selected tenants for `shared_pool` and
  `tenant_exclusive` runs.
- Continuous creation through the canonical `POST /api/admin/users` API.
- Automatic scale-out of the account-scoped roles:
  - `tenant_core/users`
  - `tenant_pii`
- Predictive automatic scale-out of physical Lookup D1 databases from monotonic successful
  route-publication observations.
- Lookup forecast persistence, idempotent capacity decisions, D1 migration/binding/readiness, and
  subsequent virtual-bucket assignment transitions.
- Low-watermark provisioning and full-capacity route transition.
- Durable retry of `202`, capacity-related `503`, and transient `5xx` responses with the same
  idempotency key. Raw `5xx` responses remain a failing reliability signal even if replay succeeds.
- Verification of Control state, Cloudflare D1 inventory, physical rows, account routes, and Lookup
  exact-search results.
- A machine-readable event timeline and final summary.

### Excluded

- Login, Authorize, Token, and UserInfo traffic.
- SCIM, profile updates, passkey/password changes, consent writes, and other concurrent mutations.
- Provisioning fault injection, Worker restart, Cloudflare API timeout, and chaos testing.
- High-concurrency stampede testing exactly at the capacity boundary.
- Existing-account rebalance or movement between shards.
- Storage-size-, latency-, or overload-triggered scale-out; Phase 1 uses account-count capacity.
- Shared-D1 to tenant-D1 or external-database migration.

## 3. System model

One logical account creation writes account-scoped data to two independently capacity-managed roles.
The test therefore treats one scale-out cycle as successful only when both roles remain writable and
the published account route resolves to the correct physical targets.

```text
Admin user create
       |
       v
Control account allocation
       |
       +--> tenant_core/users shard N
       |
       +--> tenant_pii shard N or M
       |
       +--> Lookup route publication
```

The two roles do not need to use the same shard number. Their allocations must each be valid,
active, capacity-counted exactly once, and reflected in Lookup.

Lookup uses a separate forecast and capacity path:

```text
successful route publication counters
       |
       v
durable per-capacity-domain EWMA + pinned forecast
       |
       v
projected routes + headroom > usable Lookup capacity
       |
       v
Control provisions one additional physical Lookup D1
       |
       v
migration -> bindings -> smoke/readiness -> activation
       |
       v
virtual-bucket cutover -> later routes written to the new Lookup D1
```

Requested, provisioning, ready, and active Lookup shards are counted as forecast capacity. The test
must distinguish legitimate additional capacity decisions from duplicate requests for the same
decision generation.

## 4. Test profiles

### 4.1 Smoke rehearsal

Use this only to validate the runner, observer, verifier, and cleanup procedure before the main run.

| Setting                                           |                     Value |
| ------------------------------------------------- | ------------------------: |
| Target accounts per shard                         |                       100 |
| Accounts to create                                |                     1,000 |
| Target creation rate                              |         5 accounts/second |
| Maximum in-flight requests                        |                        20 |
| Expected boundary crossings                       | 9 per account-scoped role |
| Lookup target active route rows per capacity unit |                       250 |
| Minimum physical Lookup additions                 |                         2 |

The rehearsal evidence must be stored separately and must not be presented as the main Phase 1
result. Run it in a different disposable environment from the main demonstration. Do not reuse its
shards or capacity counters for the main baseline.

### 4.2 Main demonstration

| Setting                                                    |                     Value |
| ---------------------------------------------------------- | ------------------------: |
| Target accounts per shard                                  |                    10,000 |
| Accounts to create                                         |                   100,000 |
| Target creation rate                                       |        15 accounts/second |
| Maximum in-flight requests                                 |                        64 |
| Approximate injection duration                             |               112 minutes |
| Expected assignment boundary crossings                     | 9 per account-scoped role |
| Lookup target active route rows per capacity unit          |                    25,000 |
| Minimum physical Lookup additions                          |                         5 |
| Minimum Lookup assignment transitions used by later routes |                         5 |

The low-watermark is evaluated independently from the hard placement boundary. A final unused ready
spare may therefore exist after the last account. Expected provisioning counts must be calculated
from the baseline inventory, assigned capacity, in-flight operations, configured spare policy,
observed successful route publications per account, Lookup headroom, forecast horizon, and capacity
weights; they must not be hard-coded to exactly nine D1 creations. If the canary shows that the
profile cannot reach the minimum Lookup additions, preflight must reject the run rather than silently
lowering the acceptance criterion.

## 5. Safety and prerequisites

The runner must fail before creating any account unless all preflight checks pass.

- The target is a dedicated disposable environment, not production or a shared conformance target.
- Workers Paid limits and account-level D1 capacity are sufficient for the planned D1 count and row
  writes.
- Automatic provisioning is enabled and its D1 and Workers capabilities are reported ready.
- The Control scheduled trigger is enabled and has run successfully at least once.
- The selected tenant is active, uses the placement mode declared by the run configuration, and has
  exactly one active assigned shard for each account-scoped role at the baseline. Run the harness
  once for `shared_pool` and once for `tenant_exclusive`.
- No pending, waiting, blocked, migration, cleanup, or placement operation exists for the tenant or
  target shard roles.
- The configured account target and spare policy match the selected test profile.
- The Lookup target route count, forecast horizon, EWMA alpha, headroom, policy generation, and
  physical-shard capacity weights match the selected profile and are read back exactly.
- Every participating Lookup residency policy has an explicit capacity domain. Policies sharing a
  domain must have identical residency partition, jurisdiction, and location hint; otherwise
  preflight must fail closed.
- The daily D1 create budget is at least the preflight-calculated required create count plus two
  safety units, and no unrelated operation may consume that budget during the run.
- Every Worker required by each data role is present in the desired inventory with no unresolved
  binding drift.
- The runner has a short-lived, tenant-scoped Admin credential that can create and read users.
- The observer has separate read-only access to Control state and Cloudflare resource metadata.
- The planned run ID, tenant ID, generated email namespace, initial D1 IDs, policy values, and source
  commit are captured before traffic starts.

Changing the account or Lookup target is permitted only in this disposable environment through an
explicit, audited test-fixture step. The step must update both the environment policy and the
baseline `control_shard_capacity` rows for `tenant_core/users` and `tenant_pii`; changing only the
environment default is insufficient for already-created account shards. Lookup forecast policy is
changed only in its environment policy row and its policy generation must advance. Previous values
must be recorded, and every affected row must be read back exactly. Abort if an unexpected role,
shard, environment, or row count would be changed.

Cleanup is a separate operation after evidence collection. It must target the exact run ID,
environment, tenant, and provider resource IDs captured by preflight. Do not recursively delete or
recreate a non-disposable environment.

## 6. Runner behavior

### 6.1 Deterministic identity

For account index `i`, derive the request from a random run seed and `i`:

- a unique email under a test-only domain;
- a unique idempotency key between 8 and 128 characters;
- a stable request-body digest;
- the scheduled send timestamp.

The seed must be stored outside the public summary. Evidence should contain account indices, opaque
digests, returned account IDs, operation IDs, statuses, timings, and shard IDs, but no credential,
token, raw email, or other unnecessary PII.

### 6.2 Request lifecycle

1. Submit `POST /api/admin/users` with `X-Tenant-Id` and the per-account idempotency key.
2. On `201`, record the returned account/user identity as complete.
3. On `202`, poll the returned operation URL. Retry the original request with the same idempotency
   key only when required by the operation contract.
4. On the capacity-specific `503`, retain the same request and idempotency key and retry with bounded
   exponential backoff plus jitter. The retry window is 30 minutes.
5. Treat `409`, unrelated `4xx`, unrelated `5xx`, malformed responses, or idempotency mismatches as
   terminal test failures.
6. Never replace a failed logical account with a new email or idempotency key; doing so would hide a
   lost account.

The token-bucket sender continues scheduling accounts at the configured rate while retries use a
separate bounded queue. Backpressure must cap total in-flight work at the profile limit.

## 7. Observation timeline

The observer polls frequently enough to reconstruct transitions without changing Control state.

| Signal                        | Poll interval | Required fields                                                                                                                                                            |
| ----------------------------- | ------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner counters               |      1 second | scheduled, attempted, 201, 202, 503, retries, terminal failures, in-flight                                                                                                 |
| Control shard capacity        |     5 seconds | role, shard ID, target, allocated, observed, health, allocation status                                                                                                     |
| Control operations and steps  |     5 seconds | operation ID, idempotency key, state, attempt, step, error code, timestamps                                                                                                |
| Lookup forecast decisions     |     5 seconds | capacity domain, canonical policy/partition, policy/decision generation, observations, sample/EWMA rate, horizon, forecast, projected/usable capacity, state, operation ID |
| Lookup physical shards        |     5 seconds | shard ID, capacity domain, residency partition, capacity weight, state, desired D1, binding reference                                                                      |
| Lookup bucket assignments     |     5 seconds | bucket, source/target shard, generation, state, cutover timestamps                                                                                                         |
| Tenant shard assignments      |     5 seconds | role, shard ID, generation, state, binding reference                                                                                                                       |
| Worker binding reconciliation |     5 seconds | Worker, binding, desired/observed generation, state                                                                                                                        |
| Cloudflare D1 inventory       |    15 seconds | database ID, deterministic name, creation time, size                                                                                                                       |
| Scheduled trigger health      |    60 seconds | invocation time and outcome                                                                                                                                                |

At minimum, the final timeline must identify for each account-scoped role:

- first low-watermark observation;
- provisioning operation creation;
- provider D1 creation;
- migration completion;
- binding reconciliation completion;
- smoke and stabilization completion;
- shard activation;
- first account allocated to the new shard;
- old shard reaching its target;
- each subsequent repetition of the same cycle.

For each qualifying Lookup scale-out event it must also identify:

- the observations and forecast decision that first exceeded usable capacity;
- the unique decision generation and provisioning operation;
- provider D1 creation, migration, binding reconciliation, readiness, and activation;
- the first virtual-bucket cutover to the new shard;
- the first later successful route publication whose active assignment is that shard;
- any capacity request retry, blocked state, or decision-generation change.

## 8. Test procedure

### Step 1: Preflight and baseline

Run every prerequisite check, capture the baseline inventory, and verify that creating one canary
account succeeds through the canonical API. Include the canary in the final expected count or remove
it before resetting the baseline; do not leave it unaccounted for.

### Step 2: Start observer

Start the read-only observer before the load runner. Confirm that its timestamps use UTC and that the
runner and observer clocks differ by no more than two seconds.

### Step 3: Continuous creation

Create accounts at the selected fixed rate. Do not pause the sender when provisioning begins. Apply
only the bounded retry behavior defined above.

Emit progress checkpoints at:

- 0%;
- 20%;
- each configured shard target boundary;
- each shard activation;
- 100% scheduled;
- 100% eventually completed.

### Step 4: Quiescence

After all logical accounts complete, wait until:

- all account-creation operations are terminal;
- all capacity operations are terminal;
- no binding reconciliation or provisioning lease remains;
- capacity counts stop changing for two consecutive observation windows;
- the optional final ready spare has either activated or is explicitly accounted for as in flight.

The base quiescence timeout is 30 minutes. Preflight must extend it by the configured Lookup cutover
grace and the number of assignment transitions required for acceptance, accounting for any cutovers
expected to finish during injection. The calculated deadline is recorded before the run and must not
be extended after observing a failure.

### Step 5: Full integrity verification

Verification must use independent reads rather than trusting runner response counts.

1. Count unique submitted logical accounts and unique returned account/user IDs.
2. Enumerate every active `tenant_core/users` shard and count test-run accounts.
3. Enumerate every active `tenant_pii` shard and count corresponding PII records.
4. Confirm that each submitted account exists exactly once in core storage and exactly once in the
   expected PII representation.
5. Confirm that every Control allocation points to an active shard of the correct role and was
   capacity-counted exactly once.
6. Confirm that each Lookup exact search resolves one active account and that its route projection
   matches the physical core and PII locations.
7. Confirm that no test-run identifier reservation, directory outbox, or account-creation operation
   remains pending or blocked.
8. Confirm that each provider D1 maps to exactly one desired resource and logical shard, with no
   duplicate deterministic resource names or orphaned binding targets.
9. Reconcile per-shard Control allocated counts, observed counts, and independently queried physical
   counts. Any unexplained mismatch fails the run.
10. Sample at least 100 accounts per shard for complete field-level comparison, while retaining full
    count and uniqueness checks for all accounts.
11. Recompute each Lookup publication-counter delta from captured successful activation events and
    prove that no bucket counter decreased or counted a response-loss retry twice.
12. Recompute each persisted Lookup sample rate, EWMA, forecast, usable capacity, and decision
    generation from the raw observations and pinned policy.
13. Prove that every Lookup provisioning operation has one deterministic idempotency key, one
    physical D1 desired resource, and no duplicate request for the same decision generation.
14. For every Lookup assignment transition counted toward acceptance, prove that a later route was
    published to the target shard and exact search resolves it once after cutover and grace.

### Step 6: Produce evidence

Generate the artifacts described below before cleanup. The report generator must be deterministic
from the raw evidence and run configuration.

### Step 7: Cleanup

Cleanup is allowed only after the report and integrity manifest are complete. Use the exact captured
resource inventory and verify provider absence or retained-resource state afterward. Record cleanup
separately from the Phase 1 pass/fail result.

## 9. Acceptance criteria

Phase 1 passes only when every correctness criterion passes.

| Metric                                                             |                                    Required result |
| ------------------------------------------------------------------ | -------------------------------------------------: |
| Logical account eventual success                                   |                                               100% |
| Immediate creation success (`201`, informational SLO)              |                            reported, not pass/fail |
| Server `5xx` responses                                             |                                                  0 |
| Terminal logical account failures                                  |                                                  0 |
| Lost accounts                                                      |                                                  0 |
| Duplicate core accounts                                            |                                                  0 |
| Missing or duplicate PII representations                           |                                                  0 |
| Lookup route mismatches                                            |                                                  0 |
| Cross-tenant writes                                                |                                                  0 |
| Orphan D1 resources                                                |                                                  0 |
| Duplicate provisioning for one deterministic capacity unit         |                                                  0 |
| Duplicate Lookup provisioning for one forecast decision generation |                                                  0 |
| Lookup publication-counter decreases or retry double-counts        |                                                  0 |
| Lookup forecast recomputation mismatches                           |                                                  0 |
| Physical Lookup D1 additions                                       |                         at least 5 in the main run |
| Lookup assignment transitions used by later routes                 |                         at least 5 in the main run |
| Unexplained Control/physical count mismatches                      |                                                  0 |
| Required assignment boundary crossings                             | at least 9 per account-scoped role in the main run |
| Capacity operations after quiescence                               |             all succeeded; none blocked or waiting |
| Manual intervention between first and last account                 |                                                  0 |

The test fails even if 100,000 accounts were eventually inserted when any uniqueness, route,
capacity, provisioning, or intervention criterion fails.

## 10. Evidence artifacts

Each run writes to a new timestamped directory and never overwrites prior evidence.

```text
test/scale-out-correctness-phase1/
  PLAN.md
  runs/<run-id>/
    config.redacted.json
    baseline.json
    requests.jsonl
    control-events.jsonl
    provider-events.jsonl
    integrity.json
    summary.json
    summary.md
    cleanup.json
```

`summary.md` should include a compact timeline and these headline values:

```text
Account creation eventual success  100.000%
Immediate 201 success               xx.xxx%
Lost accounts                       0
Duplicate accounts                  0
Lookup route mismatches             0
Lookup forecast mismatches          0
Manual intervention                 0
Core shard boundary crossings       N
PII shard boundary crossings        N
Lookup physical D1 additions        N
Lookup used assignment transitions  N
Provisioned D1 resources            N
```

The report must show account count on the horizontal axis and time on a secondary view. Plot separate
step lines for active `tenant_core/users`, active `tenant_pii`, and active physical Lookup shards.
Plot Lookup projected routes and usable capacity together, plus assigned bucket count per Lookup
shard. Mark provisioning start, activation, bucket cutover, first account allocation, and first route
publication events.

## 11. Planned harness files

The implementation task for this plan should add, at minimum:

- `run.ts`: fixed-rate account creator and durable retry queue;
- `observe.ts`: read-only Control and provider event collector;
- `verify.ts`: full uniqueness, physical-count, allocation, and Lookup verifier;
- `report.ts`: deterministic JSON and Markdown summary generator;
- `schemas.ts`: versioned evidence contracts with secret/PII rejection;
- unit tests for request replay, retry classification, counter reconciliation, redaction, boundary
  event detection, integer EWMA/forecast recomputation, decision idempotency, and report calculations.

The live runner must not be added to the normal offline `pnpm test` gate. Its unit tests may run in
CI, while live execution remains an explicit disposable-environment command.
