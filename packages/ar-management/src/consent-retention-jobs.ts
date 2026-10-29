import type { DatabaseAdapter, Env, PreparedStatement } from '@authrim/ar-lib-core';
import {
  consentJobSetting,
  consentJobTargets,
  ensureConsentJob,
  runConsentMaintenanceTenants,
  saveConsentJob,
  type ConsentJobStore,
} from './statement-consent-job-state';

interface ConsentRetentionLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
}
interface RetentionState {
  run_id: string;
  targets: string;
  shard: number;
  phase: 'history' | 'records';
  after_id: string;
  started_at: number;
}
const DAY_MS = 24 * 60 * 60 * 1000;

/** History precedes records, preserving the existing rule that any granted record protects history. */
export async function retainStatementConsentPage(
  metadata: DatabaseAdapter,
  tenantId: string,
  stores: readonly ConsentJobStore[],
  options: { rowPageSize: number; shardPageSize: number },
  now = Date.now()
): Promise<void> {
  if (
    !Number.isSafeInteger(options.rowPageSize) ||
    options.rowPageSize < 1 ||
    options.rowPageSize > 90 ||
    !Number.isSafeInteger(options.shardPageSize) ||
    options.shardPageSize < 1 ||
    options.shardPageSize > 32
  )
    throw new Error('consent_retention_page_invalid');
  const { ordered, targets } = consentJobTargets(stores);
  let row = await ensureConsentJob(metadata, tenantId, 'retention');
  const previous = JSON.parse(row.config) as Partial<RetentionState>;
  let state: RetentionState =
    previous.targets === targets && row.status !== 'completed'
      ? (previous as RetentionState)
      : {
          run_id: crypto.randomUUID(),
          targets,
          shard: 0,
          phase: 'history',
          after_id: '',
          started_at: now,
        };
  if (JSON.stringify(state) !== row.config) {
    if (!(await saveConsentJob(metadata, tenantId, 'retention', row, state))) return;
    row = { ...row, config: JSON.stringify(state), status: 'processing' };
  }
  for (let page = 0; page < options.shardPageSize && state.shard < ordered.length; page++) {
    const account = ordered[state.shard].adapter;
    const history = state.phase === 'history';
    const table = history ? 'consent_item_history' : 'user_consent_records';
    const records = await account.query<{
      id: string;
      statement_id: string;
      consent_settings_snapshot_at: number | string | null;
    }>(
      `SELECT id,statement_id,consent_settings_snapshot_at FROM ${table} WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?`,
      [tenantId, state.after_id, options.rowPageSize],
      { consistencyClass: 'primary_required' }
    );
    const legacyStatements = [
      ...new Set(
        records.filter((r) => r.consent_settings_snapshot_at === null).map((r) => r.statement_id)
      ),
    ];
    // Only old rows use current metadata policy. Snapshot rows are self-contained, even with
    // missing definitions or a policy that has since changed to unlimited retention.
    const policies = legacyStatements.length
      ? await metadata.query<{ id: string; record_retention_days: number | string | null }>(
          `SELECT id,record_retention_days FROM consent_statements WHERE tenant_id=? AND id IN (${legacyStatements.map(() => '?').join(',')})`,
          [tenantId, ...legacyStatements],
          { consistencyClass: 'primary_required' }
        )
      : [];
    const protectedHistory = history
      ? `AND NOT EXISTS (SELECT 1 FROM user_consent_records active_record
      WHERE active_record.tenant_id=consent_item_history.tenant_id AND active_record.user_id=consent_item_history.user_id
        AND active_record.statement_id=consent_item_history.statement_id AND active_record.status='granted')`
      : "AND status IN ('withdrawn', 'denied', 'expired')";
    const batches: PreparedStatement[] = [];
    const snapshotIds = records
      .filter((r) => r.consent_settings_snapshot_at !== null)
      .map((r) => r.id);
    if (snapshotIds.length)
      batches.push({
        sql: `DELETE FROM ${table} WHERE tenant_id=? AND id IN (${snapshotIds.map(() => '?').join(',')}) ${protectedHistory}
        AND consent_settings_snapshot_at IS NOT NULL AND retain_until IS NOT NULL AND retain_until < ?`,
        params: [tenantId, ...snapshotIds, now],
      });
    for (const policy of policies) {
      if (policy.record_retention_days === null) continue;
      const days = Number(policy.record_retention_days);
      if (!Number.isSafeInteger(days) || days < 0) continue;
      const ids = records
        .filter((r) => r.statement_id === policy.id && r.consent_settings_snapshot_at === null)
        .map((r) => r.id);
      batches.push({
        sql: `DELETE FROM ${table} WHERE tenant_id=? AND id IN (${ids.map(() => '?').join(',')}) ${protectedHistory}
        AND consent_settings_snapshot_at IS NULL AND ${history ? 'created_at' : 'updated_at'} < ?`,
        params: [tenantId, ...ids, now - days * DAY_MS],
      });
    }
    if (batches.length) {
      const result = await account.batch(batches);
      if (result.length !== batches.length || result.some((entry) => !entry.success))
        throw new Error('consent_retention_result_unknown');
    }
    const phaseDone = records.length < options.rowPageSize;
    const next: RetentionState = {
      ...state,
      after_id: phaseDone ? '' : records[records.length - 1].id,
      phase: phaseDone ? (history ? 'records' : 'history') : state.phase,
      shard: state.shard + (phaseDone && !history ? 1 : 0),
    };
    const complete = next.shard === ordered.length;
    if (
      !(await saveConsentJob(
        metadata,
        tenantId,
        'retention',
        row,
        next,
        complete ? { completed_at: now } : undefined
      ))
    )
      return;
    row = { ...row, config: JSON.stringify(next), status: complete ? 'completed' : 'processing' };
    state = next;
    if (!phaseDone) return;
    // Both bounded phases may need separate scheduler ticks; their cursor is durable too.
  }
}
export async function processConsentRetentionJobs(
  env: Env,
  log: ConsentRetentionLogger
): Promise<void> {
  const options = {
    rowPageSize: await consentJobSetting(env, 'CONSENT_RETENTION_ROW_PAGE_SIZE', 64, 90),
    shardPageSize: await consentJobSetting(env, 'CONSENT_RETENTION_SHARD_PAGE_SIZE', 1, 32),
  };
  await runConsentMaintenanceTenants(env, 'retention', log, (metadata, tenantId, stores) =>
    retainStatementConsentPage(metadata, tenantId, stores, options)
  );
  log.info('Consent retention cleanup page completed');
}
