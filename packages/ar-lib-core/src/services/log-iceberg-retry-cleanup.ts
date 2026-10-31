import { logIcebergRestorePendingSql } from './log-iceberg-restore-hold';
import {
  verifySnapshotBatch,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type IcebergLoadedTable,
} from '@authrim/ar-lib-logging/iceberg';
import {
  assertLogArchiveRecord,
  type LogArchiveRecord,
} from '@authrim/ar-lib-logging/iceberg/schema';
import type { DatabaseAdapter } from '../db/adapter';
import { ensureDatabaseAdapter } from '../db';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import {
  assertLogIcebergActivated,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import {
  createLogIcebergCatalog,
  createLogIcebergObjectStore,
  validateLogIcebergTable,
  type LogIcebergCatalogEnv,
} from './log-iceberg-catalog';
import {
  readLogIcebergRetryPayload,
  createLogIcebergWritePort,
  logIcebergMutationScope,
  type LogIcebergQueueReference,
} from './log-iceberg-runtime';
import { retireLogIcebergRetryObject } from './log-iceberg-retry-marker';
import { decryptLogIcebergRecord } from './log-iceberg-record';
import { createLogIcebergKeyResolver } from './log-iceberg-keys';
import { logIcebergRecordId } from './log-iceberg-store';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

interface RetryHead {
  id: string;
  tenant_id: string;
  storage_generation: string;
  source_dataset: string;
  subject_id: string | null;
  payload_hmac: string;
  payload_key: string;
  payload_digest: string | null;
  payload_bytes: number | null;
  expires_at: number | null;
  state: 'preparing' | 'pending' | 'queued' | 'ingested' | 'erased';
  publication_id: string | null;
  cutoff: number;
}
export interface LogIcebergRetryCleanupPorts {
  admin: DatabaseAdapter;
  catalog: IcebergCatalogPort;
  store: (table: IcebergLoadedTable) => IcebergObjectStore;
  objects: Pick<R2Bucket, 'head' | 'put'>;
  resolveTenantKey: (tenantId: string) => Promise<string>;
  readPayload: (reference: LogIcebergQueueReference) => Promise<LogArchiveRecord>;
  authenticate: (record: LogArchiveRecord, tenantKey: string) => Promise<void>;
  capturingTenantKeys: () => Promise<Set<string>>;
  coverTenant: <T>(tenantId: string, run: () => Promise<T>) => Promise<T>;
}
function reference(row: RetryHead): LogIcebergQueueReference {
  if (row.payload_digest === null || row.payload_bytes === null)
    throw new Error('log_iceberg_retry_cleanup_payload_unconfirmed');
  return {
    payload_type: 'iceberg_ingest',
    schema_version: 1,
    id: row.id,
    storage_generation: row.storage_generation,
    source_dataset: row.source_dataset,
    subject_id: row.subject_id,
    payload_hmac: row.payload_hmac,
    payload_key: row.payload_key,
    payload_digest: row.payload_digest,
    payload_bytes: row.payload_bytes,
    expires_at: row.expires_at,
  };
}
/** Metadata is retained after body retirement: it remains the idempotency and
 * immutable-PUT denial witness, and is not another searchable log body. */
export async function cleanupLogIcebergRetryPage(
  config: LogIcebergConfig,
  ports: LogIcebergRetryCleanupPorts
): Promise<{ leased: boolean; retired: number; retained: number; failed: number }> {
  if (config.mode !== 'pipeline') return { leased: false, retired: 0, retained: 0, failed: 0 };
  const lease = new LogIcebergTableLease(ports.admin, config.tableUuid);
  if (!(await lease.acquire())) return { leased: false, retired: 0, retained: 0, failed: 0 };
  const result = { leased: true, retired: 0, retained: 0, failed: 0 };
  const deadline = Date.now() + 10000;
  try {
    const rows = await ports.admin.query<RetryHead>(
      `SELECT o.*,${LOG_ICEBERG_DB_NOW} AS cutoff FROM log_iceberg_outbox o
      WHERE o.storage_generation=? AND o.payload_erased_at IS NULL AND o.next_attempt_at<=${LOG_ICEBERG_DB_NOW}
      AND ((NOT (${logIcebergRestorePendingSql('o')}) AND (o.state IN('ingested','erased') OR (o.state='preparing' AND EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=o.publication_id AND p.state='aborted')))) OR EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=o.id AND h.state='holding' AND h.expires_at IS NOT NULL AND h.expires_at<=${LOG_ICEBERG_DB_NOW}))
      ORDER BY o.next_attempt_at,o.updated_at,o.id LIMIT 32`,
      [config.generation],
      { consistencyClass: 'primary_required' }
    );
    for (const row of rows) {
      if (Date.now() >= deadline) break;
      await lease.assert();
      try {
        await ports.coverTenant(row.tenant_id, async () => {
          await lease.assert();
          if (!Number.isSafeInteger(row.cutoff) || row.cutoff < 0)
            throw new Error('log_iceberg_retry_cleanup_clock_invalid');
          const tenantKey = await ports.resolveTenantKey(row.tenant_id);
          if ((await ports.capturingTenantKeys()).has(tenantKey)) {
            result.retained++;
            return;
          }
          await ports.admin.execute(
            `UPDATE log_iceberg_restore_holds SET state='aborted' WHERE id=? AND tenant_id=? AND payload_hmac=? AND storage_generation=? AND state='holding' AND expires_at IS NOT NULL AND expires_at<=? AND ${lease.predicate}`,
            [
              row.id,
              row.tenant_id,
              row.payload_hmac,
              row.storage_generation,
              row.cutoff,
              ...lease.params,
            ]
          );
          if (row.state === 'ingested') {
            const record = await ports.readPayload(reference(row));
            assertLogArchiveRecord(record);
            if (
              record.storage_generation !== row.storage_generation ||
              record.tenant_key !== tenantKey ||
              record.source_dataset !== row.source_dataset ||
              record.payload_hmac !== row.payload_hmac ||
              record.expires_at !== row.expires_at ||
              (record.source_dataset === 'pii.pii_log' && record.subject_id !== row.subject_id) ||
              (await logIcebergRecordId(record)) !== row.id
            )
              throw new Error('log_iceberg_retry_cleanup_identity_changed');
            await ports.authenticate(record, tenantKey);
            // Consumer deliberately skips expired arrivals. Their authenticated
            // original TTL is sufficient even if a Stream row never existed.
            if (record.expires_at === null || record.expires_at > row.cutoff) {
              const table = await ports.catalog.loadTable();
              await validateLogIcebergTable(config, table);
              await verifySnapshotBatch({
                table,
                store: ports.store(table),
                tenantKey,
                sourceDatasets: [row.source_dataset],
                snapshotId: String(table.metadata['current-snapshot-id'] ?? ''),
                nowMs: row.cutoff,
                expectedRecords: [record],
              });
            }
          }
          await lease.assert();
          const changed = await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET state='erased',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND storage_generation=? AND payload_key=? AND payload_hmac=? AND COALESCE(payload_digest,'')=COALESCE(?,'') AND COALESCE(payload_bytes,0)=COALESCE(?,0) AND state=? AND (state!='preparing' OR EXISTS(SELECT 1 FROM log_iceberg_publications p WHERE p.id=log_iceberg_outbox.publication_id AND p.state='aborted') OR EXISTS(SELECT 1 FROM log_iceberg_restore_holds h WHERE h.id=log_iceberg_outbox.id AND h.state='aborted')) AND NOT (${logIcebergRestorePendingSql('log_iceberg_outbox')}) AND ${lease.predicate}`,
            [
              row.id,
              config.generation,
              row.payload_key,
              row.payload_hmac,
              row.payload_digest,
              row.payload_bytes,
              row.state,
              ...lease.params,
            ]
          );
          if (changed.rowsAffected !== 1) {
            result.retained++;
            return;
          }
          if (
            !(await retireLogIcebergRetryObject(
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
            ))
          ) {
            result.retained++;
            return;
          }
          const updated = await ports.admin.execute(
            `UPDATE log_iceberg_outbox SET payload_erased_at=${LOG_ICEBERG_DB_NOW},updated_at=${LOG_ICEBERG_DB_NOW},last_error_code=NULL WHERE id=? AND storage_generation=? AND payload_key=? AND payload_hmac=? AND state='erased' AND COALESCE(payload_digest,'')=COALESCE(?,'') AND COALESCE(payload_bytes,0)=COALESCE(?,0) AND ${lease.predicate}`,
            [
              row.id,
              config.generation,
              row.payload_key,
              row.payload_hmac,
              row.payload_digest,
              row.payload_bytes,
              ...lease.params,
            ]
          );
          await lease.assert();
          if (updated.rowsAffected === 1)
            await ports.admin.execute(
              `UPDATE log_iceberg_restore_holds SET cleanup_completed_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND tenant_id=? AND payload_hmac=? AND state='aborted' AND ${lease.predicate}`,
              [row.id, row.tenant_id, row.payload_hmac, ...lease.params]
            );
          if (updated.rowsAffected === 1) result.retired++;
          else result.retained++;
        });
      } catch (error) {
        await lease.assert();
        const code =
          error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message)
            ? error.message
            : 'log_iceberg_retry_cleanup_pending';
        await ports.admin.execute(
          `UPDATE log_iceberg_outbox SET next_attempt_at=${LOG_ICEBERG_DB_NOW}+300000,last_error_code=? WHERE id=? AND payload_erased_at IS NULL AND ${lease.predicate}`,
          [code, row.id, ...lease.params]
        );
        result.failed++;
      }
    }
    return result;
  } finally {
    await lease.release();
  }
}

export async function runLogIcebergRetryCleanup(
  env: LogIcebergCatalogEnv
): Promise<{ leased: boolean; retired: number; retained: number; failed: number }> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (config.mode !== 'pipeline') return { leased: false, retired: 0, retained: 0, failed: 0 };
  if (!env.DB_ADMIN || !env.LOG_ARCHIVE) throw new Error('log_iceberg_retry_cleanup_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-retry-cleanup');
  const writer = createLogIcebergWritePort(env, config);
  const keys = createLogIcebergKeyResolver(env);
  return cleanupLogIcebergRetryPage(config, {
    admin,
    catalog: createLogIcebergCatalog(env, config),
    store: (table) => createLogIcebergObjectStore(env, table),
    objects: env.LOG_ARCHIVE,
    resolveTenantKey: (tenantId) => writer.resolveTenantKey(tenantId),
    readPayload: (ref) => readLogIcebergRetryPayload(env, ref),
    authenticate: async (record, tenantKey) => {
      await decryptLogIcebergRecord(
        record,
        { tenantKey, sourceDataset: record.source_dataset, eventId: record.event_id },
        async (version) => keys(version)
      );
    },
    capturingTenantKeys: () => listCapturingTenantBackupTenantKeys(admin),
    coverTenant: (tenantId, run) =>
      runTenantBackupCoveredEffect(
        { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
        logIcebergMutationScope(env, tenantId),
        run
      ),
  });
}
