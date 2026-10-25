# Admin Jobs

Authrim Admin Jobs provide tenant-scoped asynchronous execution for administrative operations that should not run inside a foreground API request.

The current job system is intentionally small. It uses the `admin_jobs` table as the durable outbox and scheduled management maintenance as the executor. It is not a general workflow engine.

## Supported job types

| Job type                     | Creation API                                          | Processor | Result class         |
| ---------------------------- | ----------------------------------------------------- | --------- | -------------------- |
| `users/import`               | `POST /api/admin/jobs/users/import`                   | scheduled | `user_import_result` |
| `users/bulk-update`          | `POST /api/admin/jobs/users/bulk-update`              | scheduled | `admin_job_result`   |
| `reports/generate`           | `POST /api/admin/jobs/reports/generate`               | scheduled | `admin_job_result`   |
| `organizations/bulk-members` | `POST /api/admin/jobs/organizations/:id/bulk-members` | scheduled | `admin_job_result`   |

The Admin UI reads `GET /api/admin/jobs/types` to discover enabled job types and supported result delivery modes.

## Tenant isolation

All Admin Jobs are tenant-owned.

- Job list, status, result, and artifact APIs filter by `tenant_id`.
- Creation APIs validate tenant-owned input before creating a pending job.
- Scheduled processors may scan jobs across tenants, but each job is claimed and updated by `id` and `tenant_id`.
- Result artifacts are stored under tenant-scoped keys such as `exports/{tenantId}/...`.
- Object Catalog lookups require the request tenant and expected object class.

Scheduled execution does not rely on a request tenant context. Processors must use the tenant from the job row.

## Where jobs are kept

The jobs the scheduled runs claim are kept in `admin_jobs` of the Admin database (`DB_ADMIN`): the jobs the creation APIs above create, tenant lifecycle validations, the backup a tenant deletion takes first (`tenant-database/export`), and Support Ops cohort snapshots. The processors keep the Object Catalog entries of their results there too. A processor reads and writes the tenant's own data (accounts, organizations, cohorts) in the tenant's Core database, resolved from the job's `tenant_id`; a lifecycle validation moves the tenant in the tenant inventory (`DB`), where the lifecycle command moved it.

A tenant whose accounts are routed (`shared_pool` or `tenant_exclusive` storage) keeps them in its account databases, apart from its metadata database. Support Ops keeps its cohorts, their targets and its actions in the metadata database and reads the accounts from every account database: previews and aggregates add up the counts of all of them before any count is compared with the minimum, and an execute updates each account (with its subject) in the database that holds it. A cohort snapshot job reads the account databases one after another, in pages, and records in its progress the database and the last account it took (`store_key`, `last_target_id`), so a run that stops part-way is resumed where it stopped; a page read again does not take a target twice. An account found in more than one account database (which copy is the account is unknown) is refused with `account_store_ambiguous`: by cohort creation, by the snapshot job (each page is checked against the other databases before its targets are taken) and by execute. A count summed over the databases is checked the same way where a copy could have lifted it to the minimum (a count from the minimum up to the minimum times the number of databases): the accounts it counts are read, and a count whose accounts cannot be read back as counted is refused with `count_unverified`. A larger count is of at least the minimum number of accounts even if each were in every database. Each snapshot job run also stops at a budget of statements, as each page costs one per other database. An action's succeeded and failed counts are shown only together and only when neither is below the minimum.

Tenant deletion jobs (`tenants/delete`) stay in `admin_jobs` of the Core database their run scans. The job list, status, result and artifact APIs read both stores: the Admin database first, then the Core database. A job is in one store only.

A lifecycle command moves the tenant first and then keeps its validation job in `DB_ADMIN` (no transaction spans the two databases). When the job cannot be kept, the tenant is moved back and the same request can be sent again.

Jobs that were created in the Core database before this layout were never run. Core D1 migration `027` closes those still `pending` or `processing` as `failed` with `error_code` `admin_job_store_moved`: the four types above (create them again), lifecycle validations (retrying one moves it to `DB_ADMIN`), and Support Ops snapshots with their cohorts (create the cohort again). A deletion's backup that waited in the Core database is requested again in `DB_ADMIN` by the deletion itself, and removed from the Core database; a deletion goes on only once its backup completed.

Imports, like the generic jobs, run only while the tenant is `active`; otherwise the job ends as `partial_failure` with `tenant_lifecycle_blocked:<state>`.

## Result delivery

Generic Admin Jobs support:

- `auto`
- `inline`
- `artifact`

`inline` stores the result summary in `admin_jobs.result`.

`artifact` requires:

- `EXPORT_ARTIFACTS`
- `OBJECT_ENCRYPTION_ROOT_KEY`

When artifact delivery is used, Authrim writes an encrypted result object to `EXPORT_ARTIFACTS`, records it in Object Catalog, and returns an artifact id in the job result. Artifact reads require `admin:jobs:artifact:read` or a matching elevation grant.

`auto` stores small results inline and materializes large results when artifact storage is available.

## Retry and dead-letter state

Generic Admin Jobs track retry state in `admin_jobs`:

- `attempt_count`
- `max_attempts`
- `next_run_at`
- `dead_lettered_at`

When a processor fails before `max_attempts`, the job is returned to `pending` and scheduled with backoff. When attempts are exhausted, the job is marked `failed`, `dead_lettered_at` is set, and the final processor error is written into `admin_jobs.result` as an error log entry.

Individual session revocation uses `users/session-end-logout-v2` with the exact
`trigger.action` value `session.revoke`. Existing account-wide actions retain
`users/session-end-logout`. The versioned jobs use the same payload fields, tenant-scoped Jobs
visibility, permissions, minute-run budget, lifecycle handling and best-effort enqueue behavior
as the existing logout jobs. Older scheduled consumers ignore the new type without claiming it
or consuming retry attempts; outstanding jobs resume when a capable consumer is available.
Changing the enum inside the old job type would instead exhaust old consumers' retry budgets
after a rollback. Source Admin workflows, including both logout job types, remain held during
tenant backup restoration rather than replayed in the target environment.

## Chunked bulk updates

`users/bulk-update` runs in resumable chunks. The processor records progress in `admin_jobs.progress`, including:

- `total`
- `processed`
- `succeeded`
- `failed`
- `cursor`
- `batch_size`

The cursor is based on `users_core.id`. This gives deterministic resume behavior, but it is not a full snapshot-isolation model for tenants whose user set is changing while a job runs.

## Admin UI

The Admin UI Jobs page can:

- list jobs
- filter by status and type
- show enabled job types from `GET /api/admin/jobs/types`
- create user import jobs
- create report generation jobs
- select report result format (`json` or `csv`)
- select report result delivery (`auto`, `inline`, or `artifact`)
- view job progress, retry attempts, next run time, summaries, failures, logs, and result download links

## Reports

The current report generator supports:

- `user_activity`
- `access_summary`
- `compliance_audit`
- `security_events`

Report output supports JSON and CSV. PDF rendering is intentionally not implemented yet.

## Operational notes

Scheduled management maintenance runs these job processors:

- tenant deletion jobs
- user import jobs
- data export requests
- support operations snapshot jobs
- generic Admin Jobs

Each processor is isolated so one failing job family does not prevent the remaining job families from running in the same scheduled pass.

## API summary

| Method | Path                                                  | Purpose                                         |
| ------ | ----------------------------------------------------- | ----------------------------------------------- |
| `GET`  | `/api/admin/jobs/types`                               | Discover job types and result delivery modes    |
| `GET`  | `/api/admin/jobs`                                     | List tenant jobs                                |
| `GET`  | `/api/admin/jobs/:id`                                 | Get job status                                  |
| `GET`  | `/api/admin/jobs/:id/result`                          | Get completed or partial-failure result summary |
| `GET`  | `/api/admin/jobs/:id/result/download`                 | Download job result artifact                    |
| `GET`  | `/api/admin/jobs/artifacts/:artifactId`               | Get artifact manifest                           |
| `GET`  | `/api/admin/jobs/artifacts/:artifactId/download`      | Download artifact by public artifact id         |
| `GET`  | `/api/admin/jobs/artifacts/:artifactId/chunks/:index` | Download a chunked artifact part                |

## Support operation execution

Approved User suspension actions use `support-ops/action-execute`. This type cannot be created
through the generic Jobs API. Eligible small actions run the same durable state machine inline;
large target/session counts or an exhausted request budget return 202 with a job ID. The UI polls
the action until it leaves `running`. Closing the UI does not cancel the operation.

Execution is bounded by target pages, session scan pages (100), session transfer pages (10), a
request deadline, and an explicit budget for job SQL statements and Durable Object RPCs. This
budget is shared between Support Ops snapshot and execution jobs; it is not a global budget for
all maintenance or for archive transport internals.

The session authority retains a replayable receipt until deterministic Admin logout jobs have
been confirmed. Internal `support-ops/action-execute-logout` jobs reuse the normal minute logout
processor, and are excluded from public Jobs list, status, result, and artifact lookups. Public
execution progress excludes target IDs, session IDs, selectors, and receipts. `completed` means
account outcomes and logout-job transfer are durable; downstream delivery can still be retrying.

Account outcomes are stored atomically with the account/subject update in the dedicated Core
`support_ops_account_result_receipts` table. No tenant inventory row is required in account shards.
Unacknowledged outcomes never expire. Confirming the outcome in Admin starts a fixed one-day Core
receipt TTL; repeated ACKs do not extend it. Cleanup removes at most 25 acknowledged expired
receipts per processed account. A run-start deadline prevents an old delayed runner from
recreating a cleaned receipt. Every account store is checked before enqueueing or changing the
action: unsupported database adapters or an unavailable receipt schema return 503. Execution
currently supports D1/SQLite atomic batches, not external PostgreSQL account stores.

Jobs pin the metadata database and each active target's physical database ID, shard, assignment,
and binding-route generation. A route change blocks further effects instead of searching a new
store for an old result. This deliberately does not provide automatic recovery after placement
changes; the original evidence must remain reachable on the pinned source store.

Attempt exhaustion fixes a failed outcome but cannot skip an active session receipt or unknown
account result. Reconciliation remains pending until those are transferred and confirmed. Final
Admin audit uses a deterministic ID and exact-payload checks. Archive fanout is retried at least
once with the same event ID; external exactly-once delivery is not promised. An Admin run-owner
heartbeat precedes each side effect, while DO owner/fence/sequence enforces its local transfer.
There is no atomic lease shared across Admin, Core, and Durable Object storage.

Core result receipts are source-only ephemeral data and are excluded from tenant exports. Admin
jobs retain the existing encrypted source-workflow restore hold. Running Core support actions
are also held so that restoring a tenant cannot resume a source action without its session
receipt. Completed action/audit history retains its existing dataset rules.
