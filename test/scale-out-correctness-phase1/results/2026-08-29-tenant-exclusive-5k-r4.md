# Phase 1 tenant-exclusive 5K remediation evidence

Date: 2026-08-29  
Environment: `scaleout`  
Scenario: tenant-exclusive, accelerated 500-account shard capacity  
Evidence status: **remediation validated; clean publishable rerun still required**

## Executive summary

The initial 5,000-account run created every submitted account and found no lost, duplicate, or
misrouted data. It is nevertheless retained as a failed run because 50 unexpected server 5xx
responses occurred while newly created D1 bindings were propagating. After remediation, two live
500-account probes completed 1,000 of 1,000 account creations with zero server 5xx and zero terminal
failures, including one probe intentionally overlapped with Core and PII scale-out.

Predictive Lookup scale-out provisioned capacity before forecast demand exceeded usable capacity.
A later automatic bucket migration moved an active assignment to a newly provisioned Lookup D1 and
completed its dual-write, cutover, and 15-minute grace sequence without an error. A separate defect
that left a completed Lookup capacity decision displayed as `provisioning` was reproduced, fixed,
deployed, and observed converging to `stable` without a database edit or manual recovery.

This document is suitable as remediation evidence. It must not be presented as the final clean 5K
pass because the original run's 50 server 5xx responses remain part of its immutable result.

The original checker also required all four predictive spare Lookup D1s to receive a bucket during
the same run and recorded `0:4` as a second failure. That criterion was over-constrained: an unused
predictive spare is valid until forecast demand arrives. The plan now requires at least one completed
assignment transition to a newly added D1; the later generation 1-to-2 cutover below supplies that
evidence. The original checker output remains unchanged.

## Initial 5,000-account run

| Metric                                   |           Result |
| ---------------------------------------- | ---------------: |
| Submitted accounts                       |            5,000 |
| Eventually created                       | 5,000 (100.000%) |
| Immediate 201                            |  1,943 (38.860%) |
| Total attempts                           |           20,025 |
| Capacity 503 retries                     |           14,389 |
| Registry propagation 503 retries         |              404 |
| Unexpected server 5xx retries            |               50 |
| Terminal failures                        |                0 |
| Lost accounts                            |                0 |
| Duplicate Core accounts                  |                0 |
| Missing or duplicate PII representations |                0 |
| Lookup route mismatches                  |                0 |
| Cross-tenant writes                      |                0 |
| Orphan D1 resources                      |                0 |
| Manual intervention                      |                0 |

The run started at 2026-08-28 23:08:33 UTC and finished injection at 2026-08-29 00:31:01 UTC.
Full integrity verification completed at 00:58:34 UTC.

Core and PII each crossed ten physical shard boundaries. Four physical Lookup D1s were added during
the run. The 22 completed provisioning observations had decision-to-ready latency of 44 seconds
minimum, 61 seconds p50, 116 seconds p95, and 119 seconds maximum.

## Predictive Lookup proof

At 2026-08-28 23:41:05 UTC, Lookup had 35,939 observed active routes and 36,000 usable routes. The
EWMA forecast added 126 routes, producing 36,065 projected routes. Provisioning was therefore
required while observed demand was still 61 routes below usable capacity. The decision was recorded
at 23:40:55 UTC and its D1 was ready at 23:41:40 UTC, a 45-second decision-to-ready interval.

| Value                         |     Result |
| ----------------------------- | ---------: |
| Observed routes               |     35,939 |
| Forecast new routes           |        126 |
| Projected routes              |     36,065 |
| Usable routes before addition |     36,000 |
| Observed headroom at decision |  61 routes |
| Decision to D1 ready          | 45 seconds |

## Post-remediation account-creation probes

| Metric                          | Probe A | Probe B | Combined |
| ------------------------------- | ------: | ------: | -------: |
| Scheduled                       |     500 |     500 |    1,000 |
| Created                         |     500 |     500 |    1,000 |
| Attempts                        |     501 |   1,914 |    2,415 |
| Capacity 503                    |       0 |   1,404 |    1,404 |
| Registry propagation 503        |       0 |       0 |        0 |
| Runtime binding propagation 503 |       0 |       0 |        0 |
| Unexpected server 5xx           |       0 |       0 |        0 |
| Transport retries               |       1 |      10 |       11 |
| Terminal failures               |       0 |       0 |        0 |

The second probe deliberately crossed the next Core and PII capacity boundary. Both capacity
operations completed on attempt 2. The same durable operation was resumed; no duplicate D1 was
created. After low-watermark replenishment, both data roles converged to 13 active D1s: 12 carrying
6,000 account allocations and one empty ready spare.

## Lookup assignment and state convergence

An automatic Lookup bucket migration started dual-write at 2026-08-29 01:30:56 UTC. It selected a
newly provisioned physical Lookup D1, cut over at 01:39:29 UTC, completed the configured grace period
at 01:54:29 UTC, and reached `complete` at 01:54:55 UTC. Assignment generation advanced from 1 to 2,
the final assignment was active on the new D1, and `last_error_code` was null.

After the forecast-state reconciliation fix was deployed, the previously stale capacity decision
converged automatically to `stable` at 02:11:00 UTC:

| Final forecast field         | Result |
| ---------------------------- | -----: |
| Observed active routes       | 43,939 |
| Forecast new routes          |    141 |
| Projected routes             | 44,080 |
| Usable routes                | 45,600 |
| Active Lookup capacity units |     19 |
| Forecast state               | stable |
| Last error                   |   none |

The Lookup fleet remained at 19 active physical D1s across this recovery; the state correction did
not create another D1. A subsequent bucket rebalance was progressing normally and is not a capacity
provisioning operation.

## Inventory and convergence checks

| Check                                 | Result |
| ------------------------------------- | -----: |
| Control desired resources             |    140 |
| Control resources ready               |    140 |
| Control observed resources            |    140 |
| Unique observed provider IDs          |    140 |
| Provider/Control managed-ID set match |  exact |
| Duplicate provider IDs                |      0 |
| Duplicate provider names              |      0 |
| Orphan managed D1 resources           |      0 |
| Duplicate D1 resources                |      0 |
| Stuck provisioning resources          |      0 |
| Manual intervention                   |      0 |

Five fixed platform D1s that are intentionally outside Control's managed inventory were excluded
from the provider set comparison. The remaining provider ID set and Control's observed provider ID
set had the same count and the same SHA-256 digest.

## Publication status

The failure mechanism and its remediation are validated, and the collected evidence is retained.
The next publication milestone is a new tenant-exclusive 5,000-account run from an independently
named clean baseline, followed by equivalent shared-pool and mixed-placement runs.
