/**
 * Reclaims pipeline-mode outbox intents that a writer left behind.
 *
 * A pipeline write is one request: write the `preparing` intent, put the encrypted retry
 * envelope in R2 and record its digest, then promote the intent to `pending` in the same
 * batch as the business mutation it logs (`logIcebergOutboxStatement` with the producer's
 * guard) and dispatch it. When the writer dies, or that batch rolls back, the row stays
 * `preparing` with no publication to reconcile it (`publication_id IS NULL`), so neither
 * delivery (pending/queued only) nor retry cleanup (preparing with an aborted publication only)
 * ever touches it again. Publication-backed intents are not handled here: their publication's
 * reconciliation owns them.
 *
 * Such an orphan is never resumed: the promotion to `pending` is the only commit witness the
 * record has, and an envelope in R2 does not prove that the business action committed (an
 * invitation activation whose batch rolled back must not get a success record in the archive).
 * Nor is it erased: a durable producer may still come back after a long interruption, and it
 * must find its intent as it left it. It is acknowledged: `last_error_code` is set to
 * `LOG_ICEBERG_INTENT_ABANDONED_CODE`, a system event says that this record will not reach the
 * archive, and the status pages stop counting it as waiting. A producer that returns clears
 * the mark through its own intent statement and goes on as before.
 *
 * The envelope is retired (row `erased`, erasure marker in R2) only once the record's own
 * retention has run out: nothing can legitimately deliver an expired record any more, and an
 * `erased` row is never promoted, so the retirement cannot destroy a resumed write.
 */
import type { DatabaseAdapter } from '../db/adapter';
import { ensureDatabaseAdapter } from '../db';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import type { LogIcebergCatalogEnv } from './log-iceberg-catalog';
import { logIcebergRestorePendingSql } from './log-iceberg-restore-hold';
import { retireLogIcebergRetryObject } from './log-iceberg-retry-marker';
import {
  LOG_ICEBERG_INTENT_ABANDONED_CODE,
  createLogIcebergWritePort,
  logIcebergMutationScope,
} from './log-iceberg-runtime';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';
import { logSystemEvent } from '../utils/system-event-log';
import type { Env } from '../types/env';

export { LOG_ICEBERG_INTENT_ABANDONED_CODE };

/** An intent untouched for this long with no publication is an orphan, not a write in flight. */
export const LOG_ICEBERG_INTENT_ORPHAN_AFTER_MS = 60 * 60 * 1000;
/** A row left alone (backup capturing, lost race) is not looked at again before this. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

interface OrphanRow {
  id: string;
  tenant_id: string;
  storage_generation: string;
  source_dataset: string;
  payload_hmac: string;
  payload_key: string;
  payload_digest: string | null;
  payload_bytes: number | null;
  created_at: number;
  updated_at: number;
  cutoff: number;
}

export interface LogIcebergIntentReclaimPorts {
  admin: DatabaseAdapter;
  objects: Pick<R2Bucket, 'head' | 'put'>;
  resolveTenantKey: (tenantId: string) => Promise<string>;
  capturingTenantKeys: () => Promise<Set<string>>;
  coverTenant: <T>(tenantId: string, run: () => Promise<T>) => Promise<T>;
  /** Called once per acknowledged intent; a failure here does not undo the acknowledgement. */
  reportAbandoned: (row: {
    tenantId: string;
    recordId: string;
    sourceDataset: string;
    createdAt: number;
  }) => Promise<void>;
  now?: () => number;
}

export interface LogIcebergIntentReclaimOptions {
  /** Only intents of this tenant; a platform run takes every tenant. */
  tenantId?: string;
  /** How long an intent must have been left alone; defaults to one hour. */
  minAgeMs?: number;
  limit?: number;
}

export interface LogIcebergIntentReclaimResult {
  leased: boolean;
  /** Orphans acknowledged on this run: marked, reported, no longer counted as waiting. */
  abandoned: number;
  /** Acknowledged intents whose retention ran out: now `erased` and fenced in R2. */
  retired: number;
  /** Left as they were for now: a backup is capturing the tenant, or another path moved them. */
  retained: number;
  failed: number;
}

const EMPTY: LogIcebergIntentReclaimResult = {
  leased: false,
  abandoned: 0,
  retired: 0,
  retained: 0,
  failed: 0,
};

/** A `preparing` intent with no publication that nothing owns: not a restore, not erased. */
function unownedIntentSql(alias: string): string {
  return `${alias}.state='preparing' AND ${alias}.publication_id IS NULL AND ${alias}.payload_erased_at IS NULL AND NOT (${logIcebergRestorePendingSql(alias)})`;
}

/** The orphans the next run would acknowledge: for status pages, with the same age rule. */
export function logIcebergOrphanIntentSql(alias = 'log_iceberg_outbox', cutoffParam = '?'): string {
  return `(${unownedIntentSql(alias)} AND ${alias}.updated_at<=${cutoffParam} AND COALESCE(${alias}.last_error_code,'')!='${LOG_ICEBERG_INTENT_ABANDONED_CODE}')`;
}

/**
 * The intents a run already acknowledged: recorded as never committed, waiting for retention.
 * NULL-safe, so `NOT (...)` is true for an ordinary intent with no error code.
 */
export function logIcebergAbandonedIntentSql(alias = 'log_iceberg_outbox'): string {
  return `(${alias}.state='preparing' AND ${alias}.publication_id IS NULL AND COALESCE(${alias}.last_error_code,'')='${LOG_ICEBERG_INTENT_ABANDONED_CODE}')`;
}

export async function reclaimLogIcebergOrphanIntents(
  config: LogIcebergConfig,
  ports: LogIcebergIntentReclaimPorts,
  options: LogIcebergIntentReclaimOptions = {}
): Promise<LogIcebergIntentReclaimResult> {
  if (config.mode !== 'pipeline') return { ...EMPTY };
  const minAgeMs = options.minAgeMs ?? LOG_ICEBERG_INTENT_ORPHAN_AFTER_MS;
  const limit = Math.min(Math.max(options.limit ?? 32, 1), 100);
  if (!Number.isSafeInteger(minAgeMs) || minAgeMs < 0)
    throw new Error('log_iceberg_intent_reclaim_age_invalid');
  if (options.tenantId !== undefined && (!options.tenantId || options.tenantId.length > 256))
    throw new Error('log_iceberg_tenant_invalid');
  const now = ports.now ?? Date.now;
  const lease = new LogIcebergTableLease(ports.admin, `intent_reclaim_${config.generation}`);
  if (!(await lease.acquire())) return { ...EMPTY };
  const result: LogIcebergIntentReclaimResult = { ...EMPTY, leased: true };
  const deadline = now() + 10_000;
  const tenantClause = options.tenantId === undefined ? '' : ' AND o.tenant_id=?';
  const tenantBinds = options.tenantId === undefined ? [] : [options.tenantId];
  const columns = `o.id,o.tenant_id,o.storage_generation,o.source_dataset,o.payload_hmac,o.payload_key,o.payload_digest,o.payload_bytes,o.created_at,o.updated_at,${LOG_ICEBERG_DB_NOW} AS cutoff`;
  /** Leaves the row for a later run so one tenant cannot hold the page for every other. */
  const defer = async (row: OrphanRow) => {
    await lease.assert();
    await ports.admin.execute(
      `UPDATE log_iceberg_outbox SET next_attempt_at=${LOG_ICEBERG_DB_NOW}+${RETRY_AFTER_MS} WHERE id=? AND state='preparing' AND ${lease.predicate}`,
      [row.id, ...lease.params]
    );
    result.retained++;
  };
  const failed = async (row: OrphanRow, error: unknown) => {
    await lease.assert();
    const code =
      error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message)
        ? error.message
        : 'log_iceberg_intent_reclaim_failed';
    // An acknowledged row keeps its acknowledgement: the code is what lets its producer, and
    // the status page, tell it from one nobody has looked at.
    await ports.admin.execute(
      `UPDATE log_iceberg_outbox SET next_attempt_at=${LOG_ICEBERG_DB_NOW}+${RETRY_AFTER_MS},last_error_code=CASE WHEN last_error_code=? THEN last_error_code ELSE ? END WHERE id=? AND payload_erased_at IS NULL AND ${lease.predicate}`,
      [LOG_ICEBERG_INTENT_ABANDONED_CODE, code, row.id, ...lease.params]
    );
    result.failed++;
  };
  const capturing = async (row: OrphanRow) =>
    (await ports.capturingTenantKeys()).has(await ports.resolveTenantKey(row.tenant_id));
  try {
    // 1. Acknowledge the orphans nobody has looked at.
    const orphans = await ports.admin.query<OrphanRow>(
      `SELECT ${columns} FROM log_iceberg_outbox o
      WHERE o.storage_generation=? AND ${logIcebergOrphanIntentSql('o', `${LOG_ICEBERG_DB_NOW}-?`)}
      AND o.next_attempt_at<=${LOG_ICEBERG_DB_NOW}${tenantClause}
      ORDER BY o.next_attempt_at,o.updated_at,o.id LIMIT ?`,
      [config.generation, minAgeMs, ...tenantBinds, limit],
      { consistencyClass: 'primary_required' }
    );
    for (const row of orphans) {
      if (now() >= deadline) break;
      await lease.assert();
      try {
        await ports.coverTenant(row.tenant_id, async () => {
          await lease.assert();
          if (!Number.isSafeInteger(row.cutoff) || row.cutoff < 0)
            throw new Error('log_iceberg_intent_reclaim_clock_invalid');
          // A backup capture reads the outbox as it is: no state moves under it.
          if (await capturing(row)) return defer(row);
          // The row must still be the one selected: a writer retrying the same record between
          // the SELECT and here refreshes `updated_at` and keeps its intent unmarked.
          const changed = await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET last_error_code=?,updated_at=${LOG_ICEBERG_DB_NOW}
            WHERE id=? AND tenant_id=? AND payload_hmac=? AND updated_at=? AND ${unownedIntentSql('log_iceberg_outbox')} AND ${lease.predicate}`,
            [
              LOG_ICEBERG_INTENT_ABANDONED_CODE,
              row.id,
              row.tenant_id,
              row.payload_hmac,
              row.updated_at,
              ...lease.params,
            ]
          );
          if (changed.rowsAffected !== 1) return defer(row);
          result.abandoned++;
          try {
            await ports.reportAbandoned({
              tenantId: row.tenant_id,
              recordId: row.id,
              sourceDataset: row.source_dataset,
              createdAt: row.created_at,
            });
          } catch {
            // The mark is set; the system event is best effort.
          }
        });
      } catch (error) {
        await failed(row, error);
      }
    }
    // 2. Retire the acknowledged intents whose retention has run out.
    const expired = await ports.admin.query<OrphanRow>(
      `SELECT ${columns} FROM log_iceberg_outbox o
      WHERE o.storage_generation=? AND ${logIcebergAbandonedIntentSql('o')} AND o.payload_erased_at IS NULL
      AND o.expires_at IS NOT NULL AND o.expires_at<=${LOG_ICEBERG_DB_NOW} AND NOT (${logIcebergRestorePendingSql('o')})
      AND o.next_attempt_at<=${LOG_ICEBERG_DB_NOW}${tenantClause}
      ORDER BY o.next_attempt_at,o.expires_at,o.id LIMIT ?`,
      [config.generation, ...tenantBinds, limit],
      { consistencyClass: 'primary_required' }
    );
    for (const row of expired) {
      if (now() >= deadline) break;
      await lease.assert();
      try {
        await ports.coverTenant(row.tenant_id, async () => {
          await lease.assert();
          if (await capturing(row)) return defer(row);
          // `erased` first: a producer that still turns up skips an erased row before any PUT
          // or promotion, so the retirement below cannot take an envelope a write depends on.
          const changed = await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET state='erased',updated_at=${LOG_ICEBERG_DB_NOW}
            WHERE id=? AND tenant_id=? AND payload_hmac=? AND updated_at=? AND ${logIcebergAbandonedIntentSql('log_iceberg_outbox')} AND payload_erased_at IS NULL AND ${lease.predicate}`,
            [row.id, row.tenant_id, row.payload_hmac, row.updated_at, ...lease.params]
          );
          if (changed.rowsAffected !== 1) return defer(row);
          const retired = await retireLogIcebergRetryObject(
            ports.objects,
            {
              id: row.id,
              generation: row.storage_generation,
              key: row.payload_key,
              hmac: row.payload_hmac,
              digest: row.payload_digest,
              bytes: row.payload_bytes,
            },
            () => lease.assert()
          );
          // Retry cleanup retires `erased` rows without `payload_erased_at` on its own page.
          if (!retired) return;
          await lease.assert();
          await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET payload_erased_at=${LOG_ICEBERG_DB_NOW},updated_at=${LOG_ICEBERG_DB_NOW},last_error_code=NULL WHERE id=? AND storage_generation=? AND state='erased' AND payload_erased_at IS NULL AND ${lease.predicate}`,
            [row.id, config.generation, ...lease.params]
          );
          result.retired++;
        });
      } catch (error) {
        await failed(row, error);
      }
    }
    return result;
  } finally {
    await lease.release();
  }
}

export async function runLogIcebergIntentReclaim(
  env: LogIcebergCatalogEnv & Partial<Env>,
  options: LogIcebergIntentReclaimOptions = {}
): Promise<LogIcebergIntentReclaimResult> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (config.mode !== 'pipeline') throw new Error('log_iceberg_pipeline_mode_required');
  if (!env.DB_ADMIN || !env.LOG_ARCHIVE) throw new Error('log_iceberg_intent_reclaim_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-intent-reclaim');
  const writer = createLogIcebergWritePort(env, config);
  return reclaimLogIcebergOrphanIntents(
    config,
    {
      admin,
      objects: env.LOG_ARCHIVE,
      resolveTenantKey: (tenantId) => writer.resolveTenantKey(tenantId),
      capturingTenantKeys: () => listCapturingTenantBackupTenantKeys(admin),
      coverTenant: (tenantId, run) =>
        runTenantBackupCoveredEffect(
          { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
          logIcebergMutationScope(env, tenantId),
          run
        ),
      reportAbandoned: (row) =>
        logSystemEvent(env as Env, {
          tenantId: row.tenantId,
          source: 'authrim/log_archive_outbox',
          action: 'log_archive.intent.abandoned',
          targetType: 'log_record',
          targetId: row.recordId,
          severity: 'warning',
          details: {
            result: 'failure',
            error_code: LOG_ICEBERG_INTENT_ABANDONED_CODE,
            // `source_dataset` is the system-event store's own column; the record's dataset is data here.
            dataset: row.sourceDataset,
            intent_created_at: row.createdAt,
          },
        }),
    },
    options
  );
}
