/**
 * "This tenant has an active deletion job": the one predicate shared by everything that must not
 * take a tenant out of its deletion path (starting a second deletion, `set-default`, the lifecycle
 * commands that reactivate it) and by the job itself.
 *
 * RULE: an active deletion job wins; reactivation yields. Everything that would bring the tenant
 * back (the lifecycle commands, and the validation job that completes them) carries this guard in
 * the statement that does it, so no reactivation can race a deletion; deletion itself does not
 * need to look at reactivation jobs, because those end (terminally) when they find it active.
 *
 * A deletion job (`admin_jobs.job_type = 'tenants/delete'`) names its target in
 * `config.tenant_id` (`admin_jobs.tenant_id` is the tenant the request came through, not the
 * target), and there is no column of its own for it. The match is `json_extract(config,
 * '$.tenant_id') = ?`: exact, whatever the spacing or key order of the JSON the job writer
 * produced, and with no LIKE wildcards to reason about (`demo-1` never matches `demo-10`).
 *
 * Active is `pending` (queued or waiting for its retry), or `processing` and touched within
 * `TENANT_DELETE_JOB_STALE_SECONDS`: a job whose worker died stays `processing` for good, and a
 * `failed` or `completed` job is not active, so an operator abandons a stuck deletion by waiting
 * for its attempts to run out (`failed`) or for the stale window, after which the tenant can be
 * resumed again.
 */
export const TENANT_DELETE_JOB_STALE_SECONDS = 6 * 60 * 60;

export interface ActiveTenantDeleteJobGuard {
  /** A `SELECT 1 …` to use as `EXISTS (…)` / `NOT EXISTS (…)`; `?` placeholders are in `params`. */
  sql: string;
  params: unknown[];
}

export function activeTenantDeleteJobGuard(
  targetTenantId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ActiveTenantDeleteJobGuard {
  return {
    sql: `SELECT 1 FROM admin_jobs
           WHERE job_type = 'tenants/delete'
             AND json_extract(config, '$.tenant_id') = ?
             AND (status = 'pending' OR (status = 'processing' AND updated_at >= ?))`,
    params: [targetTenantId, nowSeconds - TENANT_DELETE_JOB_STALE_SECONDS],
  };
}

/**
 * "A deletion of this tenant was accepted at or after `sinceSeconds`", whatever that deletion's
 * status is now (`created_at` of a `tenants/delete` job is its acceptance time, wall-clock seconds; the command's
 * side is the `accepted_at` the lifecycle command recorded in its job's config, also wall-clock
 * seconds: never the job's `created_at`, which is the tenant's version and can run ahead).
 *
 * RULE: a deletion accepted after a reactivation command supersedes that command, even if the
 * deletion later failed and left the tenant in the state the command started from (a failed
 * deletion leaves it `suspended`, which an old `resume` would otherwise match again). The operator
 * sends a new command. Used by the validation job that completes a command, with the command's
 * own acceptance time (`job.created_at`).
 *
 * `>=` is intended: a deletion accepted earlier in the same second and still active would have
 * refused the command at acceptance, so the only false positive is one that was accepted and had
 * already failed before the command in that same second, which is acceptable.
 */
export function tenantDeleteAcceptedSinceGuard(
  targetTenantId: string,
  sinceSeconds: number
): ActiveTenantDeleteJobGuard {
  return {
    sql: `SELECT 1 FROM admin_jobs
           WHERE job_type = 'tenants/delete'
             AND json_extract(config, '$.tenant_id') = ?
             AND created_at >= ?`,
    params: [targetTenantId, sinceSeconds],
  };
}
