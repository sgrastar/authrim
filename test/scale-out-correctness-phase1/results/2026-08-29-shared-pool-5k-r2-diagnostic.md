# Phase 1 shared-pool 5K diagnostic evidence (r2)

Date: 2026-08-29

Environment: `scaleout`

Scenario: shared-pool, accelerated 500-account shard capacity

Evidence status: **failed diagnostic; clean uninterrupted rerun required**

## Executive summary

All 5,000 unique accounts were eventually created. Core and PII each added exactly ten D1s and
preserved one ready spare. Final verification found no lost accounts, duplicate account records,
duplicate D1s, orphan managed resources, stuck provisioning, or non-terminal Control operations.
No manual scale-system intervention was required.

The run is nevertheless a failed diagnostic, not a publication-grade Phase 1 pass. Predictive
Lookup observation remained stale and therefore produced neither a new Lookup D1 nor an assignment
transition. In addition, 30 asynchronous operation-status polls returned HTTP 503. Every affected
operation eventually converged, but the strict zero-unexpected-5xx criterion failed.

The local harness also stopped at 2,500 accounts when the test workstation reached `ENOSPC`. It was
resumed from its durable checkpoint and reached exactly 5,000 unique successes. This was a local
evidence-collection interruption, not a Control-plane failure, but it independently prevents the run
from being presented as an uninterrupted public result.

## Account creation

| Metric                             |           Result |
| ---------------------------------- | ---------------: |
| Target unique accounts             |            5,000 |
| Eventually created                 | 5,000 (100.000%) |
| Immediate 201 responses            |            4,978 |
| Accepted asynchronous operations   |               23 |
| Total account attempts             |           26,428 |
| Safe capacity 503 responses        |           15,668 |
| Registry propagation 503 responses |            5,634 |
| Operation-status polling 503       |               30 |
| Transport retry schedules          |               64 |
| Terminal account failures          |                0 |
| Lost accounts                      |                0 |
| Duplicate Core accounts            |                0 |
| Missing or duplicate PII accounts  |                0 |
| Non-committed allocations          |                0 |
| Manual scale-system intervention   |                0 |

Injection ran from 08:52:39 UTC through 10:22:37 UTC. The raw request log contains 7,500
`scheduled` records because the 2,500-account remainder was scheduled again after checkpoint
resume. This does not represent 7,500 submitted identities: the immutable idempotency boundary,
accepted responses, and final checkpoint converge to exactly 5,000 unique accounts.

Of the safe capacity responses, three were
`CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE`; all three recovered automatically. All 30 unexpected
server responses were HTTP 503 while polling accepted asynchronous account operations. Those
operations also converged without a terminal failure.

## Shared-pool scale-out

| Role                | Baseline D1s | Final D1s | Added | Baseline allocation | Final allocation | Final spare |
| ------------------- | -----------: | --------: | ----: | ------------------: | ---------------: | ----------: |
| `tenant_core/users` |            5 |        15 |    10 |               2,000 |            7,000 |           1 |
| `tenant_pii`        |            5 |        15 |    10 |               2,000 |            7,000 |           1 |

Each role grew from 2,500 to 7,500 accounts of configured capacity. The 5,000 test-tenant
allocations account for the increase from 2,000 to 7,000 allocated accounts. Exactly one empty ready
spare remained for each role after all provisioning operations quiesced.

All 20 D1 provisioning operations succeeded on attempt 2. Decision-to-ready latency across these
operations was 245 seconds minimum, 419 seconds p50, 560 seconds p95, 561 seconds maximum, and
413.3 seconds mean.

| Generation | Core decision to ready | PII decision to ready |
| ---------: | ---------------------: | --------------------: |
|          5 |                  368 s |                 542 s |
|          6 |                  304 s |                 484 s |
|          7 |                  416 s |                 309 s |
|          8 |                  382 s |                 561 s |
|          9 |                  560 s |                 300 s |
|         10 |                  444 s |                 503 s |
|         11 |                  417 s |                 421 s |
|         12 |                  314 s |                 437 s |
|         13 |                  482 s |                 296 s |
|         14 |                  481 s |                 245 s |

The operation history contains 58 `runtime_smoke_binding_unavailable`, 39
`control_worker_binding_reconciliation_failed`, and three
`control_worker_deployment_lease_busy` events. Every provisioning operation exposed at least one
such transient parent error before clearing it and succeeding. These retries remained idempotent,
but this run's latency and error presentation must not be described as normal steady-state
performance.

## Predictive Lookup result

This portion failed. At the end of the run, the last Lookup forecast observation was still the
08:40:54 UTC sample taken before account injection:

| Forecast field                | Result |
| ----------------------------- | -----: |
| Observed active routes        | 55,945 |
| Forecast new routes           |      4 |
| Active capacity units         |     24 |
| Decision generation           |     23 |
| Forecast state                | stable |
| Requested provisioning op     |   none |
| Lookup physical D1 additions  |      0 |
| New-D1 assignment transitions |      0 |

Worker logs showed scheduled executions at 10:00:41 and 10:02:41 UTC reaching the Lookup planning
code at 10:01:01 and 10:03:43 UTC respectively. The delayed execution crossed a minute boundary and
the deployed cadence check skipped the observation. The absence of a visible error was therefore
not evidence of a healthy forecast; the stale `observed_at` value is the decisive failure signal.

## Final convergence and inventory

| Check                                 | Result |
| ------------------------------------- | -----: |
| Successful provisioning operations    |  20/20 |
| Non-terminal Control operations       |      0 |
| Stuck D1 resources                    |      0 |
| Duplicate provider links              |      0 |
| Duplicate deterministic D1 names      |      0 |
| Orphan managed D1 resources           |      0 |
| Provider-missing managed D1 resources |      0 |
| Manual scale-system intervention      |      0 |

The provider contained 197 environment-named D1s. Control tracked 192 managed D1s, and the set
difference was exactly the five fixed platform databases that are intentionally outside Control's
managed inventory. Every Control-managed provider ID was present, so the managed inventory matched
without an orphan or missing resource.

## Publication status

This run is useful diagnostic evidence that shared Core/PII scale-out is eventually correct and
idempotent under repeated boundary crossings. It is not a Phase 1 pass because predictive Lookup
did not execute from fresh observations, operation polling returned 30 unexpected 503 responses,
and the local harness required an `ENOSPC` checkpoint resume. A fresh environment run must complete
with the corrections deployed, fresh Lookup transitions, zero unexpected 5xx responses, and no
local interruption before this scenario is published as a pass.
