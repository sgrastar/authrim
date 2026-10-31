import {
  createAuthContextFromHono,
  getTenantIdFromContext,
  getLogger,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import type { Context } from 'hono';
import {
  consentJobSetting,
  consentJobTargets,
  ensureConsentJob,
  readConsentJob,
  runConsentMaintenanceTenants,
  saveConsentJob,
  type ConsentJobStore,
} from './statement-consent-job-state';

interface MissingReference {
  binding_ref: string;
  record_id: string;
  statement_id: string;
  version_id: string;
  missing_statement: boolean;
  missing_version: boolean;
}
interface AuditState {
  run_id: string;
  targets: string;
  shard: number;
  after_id: string;
  started_at: number;
  scanned: number;
  unresolved: number;
  samples: MissingReference[];
}
/** Read-only evidence scan. Each page and shard is acknowledged after all metadata reads succeed. */
export async function auditStatementConsentPage(
  metadata: DatabaseAdapter,
  tenantId: string,
  stores: readonly ConsentJobStore[],
  options: { rowPageSize: number; shardPageSize: number; sampleLimit: number }
): Promise<void> {
  for (const [value, max] of [
    [options.rowPageSize, 90],
    [options.shardPageSize, 32],
    [options.sampleLimit, 100],
  ])
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw new Error('statement_consent_audit_page_invalid');
  const { ordered, targets } = consentJobTargets(stores);
  let row = await ensureConsentJob(metadata, tenantId, 'reference-audit');
  const previous = JSON.parse(row.config) as Partial<AuditState>;
  let state: AuditState =
    previous.targets === targets && row.status !== 'completed'
      ? (previous as AuditState)
      : {
          run_id: crypto.randomUUID(),
          targets,
          shard: 0,
          after_id: '',
          started_at: Date.now(),
          scanned: 0,
          unresolved: 0,
          samples: [],
        };
  // Persist target reset even if the first read fails. A completed report remains in result.
  if (JSON.stringify(state) !== row.config) {
    if (!(await saveConsentJob(metadata, tenantId, 'reference-audit', row, state))) return;
    row = { ...row, config: JSON.stringify(state), status: 'processing' };
  }
  for (let page = 0; page < options.shardPageSize && state.shard < ordered.length; page++) {
    const store = ordered[state.shard];
    const records = await store.adapter.query<{
      id: string;
      statement_id: string;
      version_id: string;
    }>(
      'SELECT id,statement_id,version_id FROM user_consent_records WHERE tenant_id=? AND id>? ORDER BY id LIMIT ?',
      [tenantId, state.after_id, options.rowPageSize],
      { consistencyClass: 'primary_required' }
    );
    const statementIds = [...new Set(records.map((r) => r.statement_id))];
    const versionIds = [...new Set(records.map((r) => r.version_id))];
    const statements = statementIds.length
      ? await metadata.query<{ id: string }>(
          `SELECT id FROM consent_statements WHERE tenant_id=? AND id IN (${statementIds.map(() => '?').join(',')})`,
          [tenantId, ...statementIds],
          { consistencyClass: 'primary_required' }
        )
      : [];
    const versions = versionIds.length
      ? await metadata.query<{ id: string; statement_id: string }>(
          `SELECT id,statement_id FROM consent_statement_versions WHERE tenant_id=? AND id IN (${versionIds.map(() => '?').join(',')})`,
          [tenantId, ...versionIds],
          { consistencyClass: 'primary_required' }
        )
      : [];
    const foundStatements = new Set(statements.map((r) => r.id));
    const foundVersions = new Map(versions.map((r) => [r.id, r.statement_id]));
    const missing = records
      .filter(
        (r) =>
          !foundStatements.has(r.statement_id) || foundVersions.get(r.version_id) !== r.statement_id
      )
      .map((r) => ({
        binding_ref: store.bindingRef,
        record_id: r.id,
        statement_id: r.statement_id,
        version_id: r.version_id,
        missing_statement: !foundStatements.has(r.statement_id),
        missing_version: foundVersions.get(r.version_id) !== r.statement_id,
      }));
    const shardDone = records.length < options.rowPageSize;
    const next: AuditState = {
      ...state,
      shard: state.shard + (shardDone ? 1 : 0),
      after_id: shardDone ? '' : records[records.length - 1].id,
      scanned: state.scanned + records.length,
      unresolved: state.unresolved + missing.length,
      samples: [...state.samples, ...missing].slice(0, options.sampleLimit),
    };
    const complete = next.shard === ordered.length;
    if (
      !(await saveConsentJob(
        metadata,
        tenantId,
        'reference-audit',
        row,
        next,
        complete
          ? {
              ...next,
              completed_at: Date.now(),
              samples_truncated: next.unresolved > next.samples.length,
            }
          : undefined
      ))
    )
      return;
    row = { ...row, config: JSON.stringify(next), status: complete ? 'completed' : 'processing' };
    state = next;
    if (!shardDone) return;
  }
}
export async function processStatementConsentReferenceAuditJobs(
  env: Env,
  log: { warn(message: string, meta?: Record<string, unknown>): void }
): Promise<void> {
  const options = {
    rowPageSize: await consentJobSetting(env, 'CONSENT_REFERENCE_AUDIT_ROW_PAGE_SIZE', 64, 90),
    shardPageSize: await consentJobSetting(env, 'CONSENT_REFERENCE_AUDIT_SHARD_PAGE_SIZE', 1, 32),
    sampleLimit: await consentJobSetting(env, 'CONSENT_REFERENCE_AUDIT_SAMPLE_LIMIT', 32, 100),
  };
  await runConsentMaintenanceTenants(env, 'reference-audit', log, (metadata, tenantId, stores) =>
    auditStatementConsentPage(metadata, tenantId, stores, options)
  );
}
/** GET /api/admin/consent-statements/reference-audit (covered by consent admin permissions). */
export async function adminConsentReferenceAuditHandler(c: Context<{ Bindings: Env }>) {
  try {
    const tenantId = getTenantIdFromContext(c);
    const row = await readConsentJob(
      createAuthContextFromHono(c, tenantId).coreAdapter,
      tenantId,
      'reference-audit'
    );
    const publicState = (raw: string | null | undefined): unknown => {
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const { targets: _targets, ...report } = parsed;
      return report;
    };
    return c.json({
      status: row?.status ?? 'not_started',
      current: publicState(row?.config),
      last_completed: publicState(row?.result),
    });
  } catch (error) {
    getLogger(c)
      .module('ADMIN_CONSENT')
      .error('Failed to read consent reference audit', {}, error as Error);
    return c.json(
      { error: 'server_error', error_description: 'Failed to read consent reference audit' },
      500
    );
  }
}
