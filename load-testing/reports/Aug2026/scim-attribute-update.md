---
project: Authrim
lang: en
date: 2026-08-16
description: 'SCIM mapped-attribute update load test report for the Authrim test environment.'
type: report
tags:
  - authrim
  - load-testing
  - performance
  - scim
  - attribute-update
  - bulk
  - testing
---

# SCIM Attribute Update Load Test Report

**Test Date**: August 16, 2026

**Target**: Authrim test environment - inbound SCIM 2.0 Users API

**Test Tool**: k6

**Operations**: Individual User PATCH and SCIM Bulk PATCH

---

## 1. Executive Summary

The test environment successfully processed mapped `displayName` updates at approximately
13.1-13.5 updates per second through individual PATCH requests. The offered rate of 14 updates per
second was not fully sustained because 30-56 scheduled iterations were dropped during each
one-minute run. At 28 updates per second, the service saturated: successful throughput fell to
10.2 updates per second, p95 latency exceeded 30 seconds, and 719 server errors were observed.

SCIM Bulk processed all operations successfully at offered rates of 10 and 30 updates per second
during one-minute runs. The 30 updates-per-second run completed 1,820 of 1,820 updates without a
dropped batch or reported error. However, p95 Bulk request latency reached 111.5 seconds, showing a
large in-flight queue. At 50 updates per second, only 1,380 of 3,000 requested updates succeeded and
81 of 150 Bulk requests timed out.

The current evidence supports the following capacity statement:

| Mode                | Current assessment                                     | Evidence                                                                                                                                                 |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Individual PATCH    | **Provisional operating limit: 10 updates/s**          | About 13.1-13.5 successful updates/s at a 14/s offer, but with dropped iterations; 10/s is a conservative recommendation and was not separately measured |
| Bulk PATCH          | **Provisional operating limit: 10 updates/s**          | 600/600 operations succeeded for one minute; no drops or errors, but p95 request latency was 53.9s                                                       |
| Bulk PATCH burst    | **30 updates/s received and processed for one minute** | 1,820/1,820 operations succeeded with no drops or errors; p95 request latency was 111.5s, so this is not yet a long-duration stable rating               |
| Bulk PATCH overload | **50 updates/s is unsupported**                        | 46% operation success; 81/150 Bulk requests timed out                                                                                                    |

These ratings apply only to the tested environment, mapping, payload, duration, and user pool. A
long-duration soak is required before publishing a production capacity or SLA.

---

## 2. Objective

Measure the current inbound SCIM attribute-update capacity against these planning targets:

| Goal                                  |   Required capacity |
| ------------------------------------- | ------------------: |
| Update 100,000 users within 1-2 hours | 13.9-27.8 updates/s |
| Individual updates                    |     14-28 updates/s |
| Bulk updates, if possible             |     30-50 updates/s |

The test was intended to establish the current baseline before performance optimization. It was not
a long-duration capacity certification.

---

## 3. Scope and Test Contract

### 3.1 Endpoint and payload

Individual update:

```http
PATCH /scim/v2/Users/{id}
Authorization: Bearer {short-lived SCIM token}
Content-Type: application/scim+json
X-Tenant-Id: default
```

```json
{
  "schemas": ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
  "Operations": [
    {
      "op": "replace",
      "path": "displayName",
      "value": "Attribute Update {run-id} {sequence}"
    }
  ]
}
```

Bulk update:

```http
POST /scim/v2/Bulk
Authorization: Bearer {short-lived SCIM token}
Content-Type: application/scim+json
X-Tenant-Id: default
```

Each Bulk request contained 20 independent PATCH operations and used `failOnErrors: 0`.

### 3.2 Mapping and data

| Item               | Test setting                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| SCIM direction     | Inbound only                                                                                                    |
| Updated attribute  | `displayName`                                                                                                   |
| Mapping            | Minimal SCIM mapping set                                                                                        |
| Resource selection | Existing SCIM User IDs loaded before the timed scenario                                                         |
| Pool loading       | Excluded from update-throughput calculations                                                                    |
| Identifier updates | Excluded; `userName` and primary email use the identifier-replacement workflow and require a separate benchmark |
| Authentication     | Dedicated short-lived SCIM bearer token                                                                         |

The test token was revoked after execution. A protected SCIM request with the revoked token returned
HTTP 401.

---

## 4. Test Execution

### 4.1 Individual PATCH matrix

| Scenario                           | Offered rate | Duration | Completed | Dropped | Successful |     Peak VUs |
| ---------------------------------- | -----------: | -------: | --------: | ------: | ---------: | -----------: |
| Smoke                              |          1/s |      20s |        21 |       0 |         21 | Not recorded |
| Target 14, first run               |         14/s |      60s |       785 |      56 |        785 | Not recorded |
| Target 14, increased VU allocation |         14/s |      60s |       811 |      30 |        811 | Not recorded |
| Target 28                          |         28/s |      60s |     1,573 |     108 |        611 |          707 |

The second 14/s run increased the pre-allocated VU capacity. It reduced, but did not eliminate,
dropped iterations. This indicates that the missed arrival rate was not only a load-generator sizing
issue; server-side latency continued to consume VUs.

### 4.2 Bulk PATCH matrix

| Scenario       | Bulk size | Offered update rate | Arrival duration | Batches | Requested updates |
| -------------- | --------: | ------------------: | ---------------: | ------: | ----------------: |
| Single request |         5 |                 N/A |      One request |       1 |                 5 |
| Single request |        20 |                 N/A |      One request |       1 |                20 |
| Bulk 10        |        20 |                10/s |              60s |      30 |               600 |
| Bulk 30        |        20 |                30/s |              60s |      91 |             1,820 |
| Bulk 50        |        20 |                50/s |              60s |     150 |             3,000 |

Bulk requests were allowed to finish during the configured graceful-stop period. Therefore, the
arrival window and end-to-end wall-clock completion window are not the same.

---

## 5. Results

### 5.1 Individual PATCH performance

| Scenario                 | Success among completed | Effective successful rate |     p95 |          p99 | Conflicts | Server errors |                100k projection |
| ------------------------ | ----------------------: | ------------------------: | ------: | -----------: | --------: | ------------: | -----------------------------: |
| Smoke                    |                    100% |                 About 1/s |  2.457s | Not recorded |         0 |             0 |                       Not used |
| Target 14, first run     |                    100% |                  13.083/s |  9.304s |       9.824s |         0 |             0 |                         2.123h |
| Target 14, increased VUs |                    100% |                  13.517/s | 16.201s |      16.793s |         0 |             0 |                         2.055h |
| Target 28                |                  38.84% |                  10.183/s | 30.314s |      33.402s |         0 |           719 | 2.728h based on successes only |

Interpretation:

1. Completed updates were reliable at the 14/s offer, but the test could not start every scheduled
   iteration.
2. Adding VUs improved the completed count only modestly and increased tail latency.
3. Raising the offer to 28/s caused saturation, server errors, client connection timeouts, and lower
   successful throughput.
4. The individual PATCH path does not currently meet the 14-28 updates/s goal with both full arrival
   delivery and a safety margin.

### 5.2 Bulk PATCH performance

| Scenario  | Successful updates | Operation success |             Dropped batches | Effective rate during offer window | p95 request latency | p99 request latency |                         Server errors |
| --------- | -----------------: | ----------------: | --------------------------: | ---------------------------------: | ------------------: | ------------------: | ------------------------------------: |
| Single 5  |                5/5 |              100% |                           0 |         0.502/s, serial equivalent |              9.957s |        Not recorded |                                     0 |
| Single 20 |              20/20 |              100% |                           0 |         0.570/s, serial equivalent |             35.103s |        Not recorded |                                     0 |
| Bulk 10   |            600/600 |              100% |                           0 |                           10.000/s |             53.855s |             55.613s |                                     0 |
| Bulk 30   |        1,820/1,820 |              100% |                           0 |                           30.333/s |            111.497s |            114.095s |                                     0 |
| Bulk 50   |        1,380/3,000 |               46% | 0 scheduled batches dropped |                23.000 successful/s |            179.970s |            179.973s | 0 reported 5xx; 81 requests timed out |

Interpretation:

1. A single Bulk request appears to process its PATCH operations largely in sequence: increasing the
   batch from 5 to 20 increased request latency from about 10 seconds to about 35 seconds.
2. The 10/s and 30/s scenarios reached their offered update rates by keeping many slow Bulk requests
   in flight concurrently.
3. The 30/s run proves one-minute acceptance and eventual successful processing, but the 111.5-second
   p95 latency indicates substantial queueing. It must not yet be described as a long-duration stable
   capacity.
4. The 50/s offer exceeded current capacity. The effective successful rate fell to 23/s and 54% of
   operations did not complete successfully.

### 5.3 Planning-target assessment

| Target                       | Result                                                                                                            | Assessment                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 100,000 updates in 1-2 hours | Individual PATCH projects to 2.06-2.12h near the 14/s offer                                                       | **Not met by individual PATCH**                             |
| 100,000 updates in 1-2 hours | Bulk 30 projects to 0.916h from offer-window throughput, or approximately 0.948h when adding one final 114s drain | **Met in a one-minute trial only; soak required**           |
| Individual 14-28 updates/s   | About 13.5 successful updates/s maximum at the 14/s offer; 28/s saturated                                         | **Not met**                                                 |
| Bulk 30-50 updates/s         | 30/s succeeded for one minute; 50/s had 46% operation success                                                     | **Lower bound demonstrated as a burst; full range not met** |

The 100,000-user projections are linear estimates. They do not account for latency growth, platform
variance, database growth, token renewal, retries, or resource-pool effects during a one- to two-hour
run.

---

## 6. Data Integrity and Recovery Checks

After the overload runs:

| Check                                | Result                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| SCIM User list request (`count=100`) | HTTP 200                                                       |
| Sampled updated values               | All 100 sampled users contained an attribute-update value      |
| Additional PATCH after overload      | HTTP 200                                                       |
| GET of the additionally updated user | HTTP 200 with the exact persisted `displayName`                |
| Identifier conflicts                 | 0 observed in the individual PATCH runs                        |
| Service recovery                     | Basic list, PATCH, and GET operations succeeded after overload |

These checks show that the sampled resources remained readable and that the service recovered after
the test. They do not prove that every operation that timed out at the client was rolled back or
eventually completed exactly once.

---

## 7. Current Operating Guidance

Until a longer soak test is completed:

| Workload          | Guidance                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Individual PATCH  | Start at no more than **10 updates/s** and use bounded retries with backoff. This is a conservative recommendation inferred from the 14/s result, not a separately certified measurement. |
| Bulk PATCH        | Start at **10 updates/s**, Bulk size 20, and allow long request timeouts. This rate completed 600/600 operations in the one-minute test.                                                  |
| Short Bulk burst  | **30 updates/s** can be accepted and processed for one minute in the tested environment, but request latency may exceed 110 seconds and in-flight work accumulates.                       |
| Unsupported load  | Do not offer **50 updates/s** to the current test deployment.                                                                                                                             |
| Production sizing | Do not publish an SLA from this report. Run a 1-2 hour soak with a representative user pool and monitoring first.                                                                         |

For operational use, the client should limit concurrency, retry transient failures with jittered
backoff, preserve idempotent intent, and avoid immediately retrying a client timeout without first
considering that the server may still have processed the operation.

---

## 8. Observed Saturation Pattern

The following is an inference from the load-test behavior, not a result of runtime profiling:

1. Account storage-route resolution and lifecycle-compatible routing add work to every PATCH.
2. Core account, PII, lookup, response reconstruction, audit, and related state may require multiple
   storage round trips.
3. Shared database writes appear to queue or serialize as concurrency increases.
4. Bulk PATCH appears to execute operations mainly in sequence inside each request; higher throughput
   is obtained by running many long-lived Bulk requests concurrently.

The evidence for queueing is the rapid latency increase and throughput collapse as offered load rises:

| Load point       | Observed behavior                                                   |
| ---------------- | ------------------------------------------------------------------- |
| Individual smoke | p95 2.5s                                                            |
| Individual 14/s  | p95 9.3-16.2s                                                       |
| Individual 28/s  | p95 30.3s, 719 server errors                                        |
| Bulk 30/s        | p95 111.5s, success retained for one minute                         |
| Bulk 50/s        | Requests reached the 180s timeout and operation success fell to 46% |

---

## 9. Limitations and Required Follow-up

This report does not validate:

- sustained operation for one to two hours;
- 100,000 actual updates in one run;
- production-sized data, tenants, regions, or traffic competition;
- Cloudflare Worker, D1, Durable Object, Queue, or service-binding telemetry correlation;
- `userName` replacement performance;
- primary-email replacement performance, including uniqueness and lookup updates;
- simultaneous updates to the same user and ETag conflict behavior under load;
- mixed create, read, update, deactivate, and reactivate traffic;
- behavior during token rotation, deployment, database migration, or regional disruption;
- exact completion state of operations whose client request timed out.

Recommended next tests:

1. Run Bulk at 10 updates/s for at least 30 minutes.
2. Run Bulk at 20 updates/s for at least 30 minutes if the first soak is clean.
3. Run Bulk at 30 updates/s for one to two hours only after queue depth, database latency, and error
   telemetry are available.
4. Run individual PATCH at 10, 12, and 14 updates/s to establish a measured no-drop operating point.
5. Benchmark primary-email updates separately with a lower starting rate.

---

## 10. Future Optimization Candidates

The following items are candidates for future tuning. They are ordered to reduce per-operation work
before increasing concurrency or changing the storage topology.

### 10.1 Remove redundant reads and unrelated writes

This is the preferred first optimization because it can improve SCIM, CSV import, Admin API, and
other provisioning paths that share the account-update services.

For a non-identifier update such as `displayName`, build an explicit change set and execute only the
affected persistence steps:

| Change class      | Required work                                                                             | Work that should normally be skipped                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile attribute | Validate and persist the mapped profile field; maintain version, ETag, and audit evidence | User-name uniqueness, email uniqueness, identifier replacement, authentication revalidation, active-state transition, and unrelated Core/PII writes |
| User name         | Validate uniqueness and run the durable identifier-replacement workflow                   | Unrelated email replacement and active-state transition                                                                                             |
| Primary email     | Validate syntax and uniqueness and run the durable lookup replacement workflow            | Unrelated user-name replacement and active-state transition                                                                                         |
| Active state      | Run the lifecycle transition and directory consistency workflow                           | Identifier replacement when identifiers did not change                                                                                              |

Where the response contract permits, construct the updated SCIM representation from the already
loaded canonical state plus the committed change set instead of performing a second full read after
the write. Preserve version/ETag behavior, audit evidence, tenant isolation, mapped-field validation,
and all identifier/lifecycle invariants. Keep the current no-op update semantics initially; deciding
whether an equal-value PATCH advances `lastModified` or ETag is a separate contract decision.

Expected benefit: fewer storage round trips, shorter transactions, and less write contention. The
actual gain must be measured; this report does not assign a performance improvement percentage.

### 10.2 Add a storage-route fast path with fallback

Resolve a lifecycle-compatible account destination directly when a fresh, tenant-scoped route is
available. If the route is missing, stale, inconsistent, or belongs to another tenant, fall back to
the current authoritative resolution path. The optimization must not bypass reactivation handling,
route revalidation, storage migration, or tenant isolation.

### 10.3 Add bounded parallelism inside Bulk

After reducing the cost of a single update, execute independent Bulk operations with a small fixed
concurrency limit, initially four and increased only with evidence. Preserve request-order response
correlation, `failOnErrors` behavior, per-operation error responses, ETag conflicts, and tenant
boundaries. Do not apply unconstrained parallelism: the 50 updates/s test already shows that simply
adding more in-flight work increases timeouts and lowers successful throughput.

### 10.4 Review storage layout and sharding only if still required

Consider write-shard distribution, queue ownership, or a different durable storage profile only if
the preceding changes and soak tests still fail the target. Storage-topology changes have the widest
migration, consistency, rollback, and operational impact and should not be the first response to the
current result.

### 10.5 Safety and acceptance criteria

Before adopting any optimization:

- retain negative tests for tenant isolation and stale-route fallback;
- retain user-name and email uniqueness, including case-insensitive conflicts;
- retain deactivate/reactivate behavior and same-account restoration;
- retain ETag/If-Match behavior, audit events, and error redaction;
- verify that failure does not leave partial Core, PII, Lookup, or directory state;
- repeat the individual 10/12/14/28 updates/s matrix and the Bulk 10/20/30/50 matrix;
- complete a one- to two-hour soak before raising the documented stable operating point.

The desired post-tuning result remains 100,000 updates within one to two hours, individual update
capacity of 14-28 updates/s, and Bulk capacity of at least 30 updates/s without relying on an
ever-growing in-flight queue.

---

## 11. Benchmark Implementations

- Individual PATCH: `load-testing/scripts/benchmarks/test-scim-attribute-update-benchmark.js`
- Bulk PATCH: `load-testing/scripts/benchmarks/test-scim-bulk-attribute-update-benchmark.js`

Both scripts require `BASE_URL` and `SCIM_TOKEN`, default to tenant `default`, exclude user-pool
loading from timed throughput, and avoid printing the SCIM token.

---

**Current conclusion**: The test deployment can process approximately 13 individual mapped-attribute
updates per second, but has not demonstrated a no-drop 14/s run. Bulk has demonstrated complete
processing at 30 updates per second for one minute, with high queueing latency; 10 updates per second
is the provisional operating point until a long-duration soak confirms a higher stable rate.

_Test conducted: August 16, 2026_
