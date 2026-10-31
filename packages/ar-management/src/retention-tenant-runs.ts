/**
 * When each retention task last ran for a tenant. A task run covers one page of tenants (or, for
 * diagnostic logs, a few tenants and one page of objects each), so the task's own last run does not
 * say when a given tenant was last cleaned; each task records that per tenant here.
 */
import type { Env } from '@authrim/ar-lib-core';
import type { AuditCleanupTenantOutcome } from './audit-maintenance';

export type RetentionTaskId =
  | 'audit_retention'
  | 'check_api_audit_retention'
  | 'user_tombstone_retention'
  | 'r2_diagnostic_log_retention'
  | 'compliance_report_retention';

/** A tenant's last run of a retention task. */
export interface TenantRetentionRun {
  at: number;
  outcome: AuditCleanupTenantOutcome | 'failed';
}

export type TenantRetentionRuns = Partial<Record<RetentionTaskId, TenantRetentionRun>>;

const TENANT_RUN_PREFIX = 'jobs:retention-tenant-run:v1:';
const RETENTION_TASK_IDS: readonly RetentionTaskId[] = [
  'audit_retention',
  'check_api_audit_retention',
  'user_tombstone_retention',
  'r2_diagnostic_log_retention',
  'compliance_report_retention',
];
// One key per task and tenant: each is written once per run by its own task, so tasks never
// overwrite each other's record and no key is written more than once a second.
function tenantRunKey(task: RetentionTaskId, tenantId: string): string {
  return `${TENANT_RUN_PREFIX}${task}:${tenantId}`;
}

const TENANT_RUN_OUTCOMES: ReadonlySet<string> = new Set<TenantRetentionRun['outcome']>([
  'cleaned',
  'archive_only',
  'not_supported',
  'archive_copy_failed',
  'failed',
]);

/** A stored run, or null when it is missing or not one this code writes. */
function parseTenantRun(raw: string | null): TenantRetentionRun | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; outcome?: unknown } | null;
    if (
      parsed &&
      typeof parsed.at === 'number' &&
      Number.isSafeInteger(parsed.at) &&
      parsed.at >= 0 &&
      typeof parsed.outcome === 'string' &&
      TENANT_RUN_OUTCOMES.has(parsed.outcome)
    ) {
      return { at: parsed.at, outcome: parsed.outcome as TenantRetentionRun['outcome'] };
    }
    return null;
  } catch {
    return null;
  }
}

/** When each retention task last ran for the tenant; a task is absent when never (or unreadable). */
export async function readTenantRetentionRuns(
  env: Env,
  tenantId: string
): Promise<TenantRetentionRuns> {
  const kv = env.AUTHRIM_CONFIG;
  if (!kv) return {};
  const runs = await Promise.all(
    RETENTION_TASK_IDS.map(
      async (task) => [task, parseTenantRun(await kv.get(tenantRunKey(task, tenantId)))] as const
    )
  );
  const result: TenantRetentionRuns = {};
  for (const [task, run] of runs) {
    if (run) result[task] = run;
  }
  return result;
}

export async function recordTenantRun(
  env: Env,
  tenantId: string,
  task: RetentionTaskId,
  run: TenantRetentionRun,
  log: { warn(message: string, context?: Record<string, unknown>): void }
): Promise<void> {
  try {
    await env.AUTHRIM_CONFIG?.put(tenantRunKey(task, tenantId), JSON.stringify(run));
  } catch (error) {
    // The cleanup itself is done; only its record is missing (the view shows the task's run).
    log.warn('Retention run could not be recorded for a tenant', {
      tenantId,
      task,
      errorType: error instanceof Error ? error.name : 'Unknown',
    });
  }
}
