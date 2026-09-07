# Phase 1 tenant-exclusive 5K evidence (r5)

Date: 2026-08-29  
Environment: `scaleout`  
Scenario: tenant-exclusive, accelerated 500-account shard capacity  
Evidence status: **failed; clean uninterrupted rerun required**

## Executive summary

All 5,000 submitted accounts were eventually created and integrity verification found no lost,
duplicate, misrouted, cross-tenant, pending, or orphaned data. Core and PII each crossed ten shard
boundaries, four predictive Lookup D1s were added, and an active Lookup bucket assignment moved to a
new D1. The run is nevertheless retained as failed evidence because four raw server 5xx responses
occurred and the publication criterion requires zero.

The local harness also stopped after 4,500 accounts when the test workstation reached `ENOSPC`. It
resumed from its durable checkpoint and completed all verification, but this means r5 was not one
uninterrupted execution. This limitation is recorded independently from Authrim's scale-out result.

## Account creation and integrity

| Metric                                   |           Result |
| ---------------------------------------- | ---------------: |
| Submitted accounts                       |            5,000 |
| Eventually created                       | 5,000 (100.000%) |
| Immediate 201                            |  1,437 (28.740%) |
| Total attempts                           |           22,356 |
| Capacity 503 retries                     |           13,649 |
| Registry propagation 503 retries         |            3,456 |
| Runtime binding propagation 503 retries  |                0 |
| Unexpected server 5xx retries            |                4 |
| Terminal failures                        |                0 |
| Lost accounts                            |                0 |
| Duplicate Core accounts                  |                0 |
| Missing or duplicate PII representations |                0 |
| Lookup route mismatches                  |                0 |
| Cross-tenant writes                      |                0 |
| Orphan D1 resources                      |                0 |
| Pending account operations               |                0 |
| Pending routing outbox rows              |                0 |
| Duplicate provisioning decisions         |                0 |
| Manual scale-system intervention          |                0 |

The run started at 02:37:25 UTC, injection finished at 04:02:07 UTC, and integrity verification
finished at 04:48:44 UTC. The four 5xx responses were retried with the same idempotency keys and all
four accounts converged successfully. Historical exception details could not be recovered because
Workers Observability was disabled at the time; no setting was changed as part of this investigation.

## Scale-out and timing

| Metric                              | Result |
| ----------------------------------- | -----: |
| Core boundary crossings            |     10 |
| PII boundary crossings             |     10 |
| Core physical D1 additions         |     10 |
| PII physical D1 additions          |     10 |
| Lookup physical D1 additions       |      4 |
| Lookup assignment transitions used |      1 |
| Total provisioned D1 resources     |     24 |
| Excess Core / PII provisioning     |  0 / 0 |

Twenty-two provisioning events had complete decision-to-ready observations: 38 seconds minimum,
61 seconds p50, 118 seconds p95, and 119 seconds maximum. Two additional successful late Core/PII
operations lacked a ready timestamp in the observer window and are excluded from the latency sample.

The final recorded predictive Lookup decision observed 53,942 active routes and forecast 342 new
routes, for 54,284 projected routes against 52,800 usable routes. Control decided at 04:11:01 UTC and
the D1 was ready at 04:11:39 UTC, a 38-second interval. The Lookup fleet reached 23 active capacity
units (55,200 usable routes), and a scheduled bucket migration completed dual-write, cutover, and
grace processing with equal source and target row counts.

## Targeted follow-up probes

Two consecutive 500-account probes were run while live `ar-management` error tailing was active. The
first completed 500/500 immediately. The second intentionally exhausted the ready Core/PII spare,
observed 1,664 safe capacity 503 retries, provisioned both replacements, and then completed 500/500.
Combined results were 1,000/1,000 created, zero server 5xx, and zero terminal failures.

The second probe reproduced normal binding propagation as parent operations temporarily carrying
`runtime_smoke_binding_unavailable` and `control_worker_binding_reconciliation_failed`. Both
operations completed on attempt 2, every target reached `succeeded`, all errors cleared, and no
duplicate or stuck resource remained. This established that the progress was idempotent but that
normal retry states were being exposed too aggressively as errors.

## Publication status

r5 demonstrates correct eventual scale-out, predictive Lookup provisioning, assignment movement,
and data integrity, but it is not a Phase 1 pass. A fresh environment run must complete without raw
5xx responses and without a local harness interruption before it is presented as final pass evidence.
