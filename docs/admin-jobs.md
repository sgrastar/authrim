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
