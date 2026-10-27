import {
  planSnapshotRowDeletePage,
  createSnapshotDeleteIntent,
  prepareSnapshotRowDelete,
  commitSnapshotRowDelete,
  reconcileSnapshotRowDelete,
  encodeSnapshotDeleteState,
  decodeSnapshotDeleteState,
  assertIcebergSnapshotLineage,
  IcebergLifecycle,
  IcebergCommitUnknownError,
  type SnapshotScanCursor,
  type SnapshotDeleteMutation,
} from '@authrim/ar-lib-logging/iceberg';
import { ensureDatabaseAdapter } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import {
  assertLogIcebergActivated,
  assertLogIcebergRemoteConfig,
  resolveLogIcebergConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import { validateLogIcebergTable, type LogIcebergCatalogEnv } from './log-iceberg-catalog';
import { createLogIcebergWritePort, logIcebergMutationScope } from './log-iceberg-runtime';
import { logIcebergDigest } from './log-iceberg-store';
import { logIcebergRetentionScopeId } from './log-iceberg-retention-scope';
import { prepareLogIcebergStreamObservations } from './log-iceberg-subject-erasure';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import {
  createLogIcebergPhysicalRemovalPorts,
  runLogIcebergPhysicalRetentionStep,
  runLogIcebergPhysicalMetadataStep,
  type LogIcebergPhysicalErasurePorts,
} from './log-iceberg-physical-erasure';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';

interface Scope {
  tenantId: string;
  tenantKey: string;
  sourceDataset: string;
}
interface Job {
  id: string;
  tenant_id: string;
  tenant_key: string;
  source_dataset: string;
  cutoff: number;
  state: 'pending' | 'sweeping' | 'completed';
  snapshot_id: string | null;
  scan_cursor_json: string | null;
  mutation_receipt_json: string | null;
  mutation_history_json: string;
}
interface Receipt {
  version: 1;
  logicalVerified: boolean;
  deleteState?: string;
  gcReceiptJson?: string;
}
function receipt(text: string | null): Receipt | undefined {
  if (text === null) return undefined;
  if (text.length > 512 * 1024) throw new Error('log_iceberg_retention_receipt_invalid');
  const v: unknown = JSON.parse(text);
  if (
    !v ||
    typeof v !== 'object' ||
    !('version' in v) ||
    v.version !== 1 ||
    !('logicalVerified' in v) ||
    typeof v.logicalVerified !== 'boolean' ||
    ('deleteState' in v && typeof v.deleteState !== 'string') ||
    ('gcReceiptJson' in v && typeof v.gcReceiptJson !== 'string')
  )
    throw new Error('log_iceberg_retention_receipt_invalid');
  return v as Receipt;
}
function history(job: Job): string[] {
  if (job.mutation_history_json.length > 256 * 1024)
    throw new Error('log_iceberg_retention_history_invalid');
  const v: unknown = JSON.parse(job.mutation_history_json);
  if (!Array.isArray(v) || v.length > 8 || v.some((x) => typeof x !== 'string'))
    throw new Error('log_iceberg_retention_history_invalid');
  return v as string[];
}
async function load(admin: DatabaseAdapter, id: string): Promise<Job> {
  const row = await admin.queryOne<Job>(
    'SELECT * FROM log_iceberg_retention_jobs WHERE id=?',
    [id],
    { consistencyClass: 'primary_required' }
  );
  if (!row) throw new Error('log_iceberg_retention_job_missing');
  return row;
}
async function save(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  id: string,
  value: Receipt
): Promise<void> {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 512 * 1024)
    throw new Error('log_iceberg_retention_receipt_budget');
  await admin.execute(
    `UPDATE log_iceberg_retention_jobs SET state='sweeping',mutation_receipt_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
    [text, id, ...lease.params]
  );
  await lease.assert();
}
async function localExpired(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  job: Job
): Promise<number> {
  const rows = await admin.query<{
    id: string;
    payload_hmac: string;
    expires_at: number;
    batch_id: string | null;
  }>(
    `SELECT id,payload_hmac,expires_at,batch_id FROM log_iceberg_records WHERE tenant_id=? AND source_dataset=? AND expires_at IS NOT NULL AND expires_at<=? ORDER BY id LIMIT 32`,
    [job.tenant_id, job.source_dataset, job.cutoff],
    { consistencyClass: 'primary_required' }
  );
  if (!rows.length) return 0;
  const ids = JSON.stringify(rows.map((r) => r.id)),
    batches = JSON.stringify([...new Set(rows.flatMap((r) => (r.batch_id ? [r.batch_id] : [])))]);
  await admin.batch([
    {
      sql: `INSERT INTO log_iceberg_event_receipts(id,tenant_id,source_dataset,payload_hmac,expires_at,state,created_at) SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.payload_hmac'),json_extract(value,'$.expires_at'),'erased',${LOG_ICEBERG_DB_NOW} FROM json_each(?) WHERE ${lease.predicate} ON CONFLICT(id) DO UPDATE SET state=CASE WHEN log_iceberg_event_receipts.tenant_id=excluded.tenant_id AND log_iceberg_event_receipts.source_dataset=excluded.source_dataset AND log_iceberg_event_receipts.payload_hmac=excluded.payload_hmac AND log_iceberg_event_receipts.expires_at IS excluded.expires_at THEN 'erased' ELSE NULL END`,
      params: [job.tenant_id, job.source_dataset, JSON.stringify(rows), ...lease.params],
    },
    {
      sql: `UPDATE log_iceberg_export_batches SET state='done',last_error_code=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND ${lease.predicate}`,
      params: [
        'log_iceberg_retention_' + job.id,
        batches,
        job.tenant_id,
        job.source_dataset,
        ...lease.params,
      ],
    },
    {
      sql: `UPDATE log_iceberg_records SET batch_id=NULL WHERE batch_id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND ${lease.predicate}`,
      params: [batches, job.tenant_id, job.source_dataset, ...lease.params],
    },
    {
      sql: `DELETE FROM log_iceberg_record_parts WHERE record_id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND ${lease.predicate}`,
      params: [ids, job.tenant_id, ...lease.params],
    },
    {
      sql: `DELETE FROM log_iceberg_records WHERE id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND expires_at IS NOT NULL AND expires_at<=? AND ${lease.predicate}`,
      params: [ids, job.tenant_id, job.source_dataset, job.cutoff, ...lease.params],
    },
  ]);
  await lease.assert();
  return rows.length;
}
/** One tenant/dataset at its original TTL. DB-only age never authorizes this
 * deletion: cutoff is compared only with the immutable total-retention expiry. */
export async function retainLogIcebergScopePage(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts,
  input: Scope
): Promise<{ complete: boolean; processed: number }> {
  if (
    !input.tenantId ||
    input.tenantId.length > 256 ||
    !input.tenantKey ||
    input.tenantKey.length > 256 ||
    input.sourceDataset.length > 256 ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(input.sourceDataset)
  )
    throw new Error('log_iceberg_retention_scope_invalid');
  assertLogIcebergRemoteConfig(config);
  const lease = new LogIcebergTableLease(ports.admin, config.tableUuid);
  if (!(await lease.acquire())) return { complete: false, processed: 0 };
  let processed = 0;
  try {
    const id = await logIcebergRetentionScopeId(config, input);
    await ports.admin.execute(
      `INSERT INTO log_iceberg_retention_jobs(id,table_uuid,storage_generation,tenant_id,tenant_key,source_dataset,cutoff,state,created_at,updated_at) SELECT ?,?,?,?,?,?,${LOG_ICEBERG_DB_NOW},'pending',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE ${lease.predicate} ON CONFLICT(id) DO NOTHING`,
      [
        id,
        config.tableUuid,
        config.generation,
        input.tenantId,
        input.tenantKey,
        input.sourceDataset,
        ...lease.params,
      ]
    );
    let job = await load(ports.admin, id);
    if (
      job.tenant_id !== input.tenantId ||
      job.tenant_key !== input.tenantKey ||
      job.source_dataset !== input.sourceDataset
    )
      throw new Error('log_iceberg_retention_identity_changed');
    await lease.assert();
    const capturing = await (ports.capturingTenantKeys
      ? ports.capturingTenantKeys()
      : listCapturingTenantBackupTenantKeys(ports.admin));
    if (capturing.has(input.tenantKey)) return { complete: false, processed };
    if (job.state === 'completed') {
      await ports.admin.execute(
        `UPDATE log_iceberg_retention_jobs SET state='pending',cutoff=${LOG_ICEBERG_DB_NOW},snapshot_id=NULL,scan_cursor_json=NULL,mutation_receipt_json=NULL,mutation_history_json='[]',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      job = await load(ports.admin, id);
    }
    processed = await localExpired(ports.admin, lease, job);
    if (processed === 32) return { complete: false, processed };
    let table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    await lease.assert();
    let value = receipt(job.mutation_receipt_json);
    if (value?.deleteState && !value.logicalVerified) {
      let mutation = decodeSnapshotDeleteState(value.deleteState);
      const committed = await reconcileSnapshotRowDelete(ports.catalog, mutation);
      if (!committed) {
        table = await ports.catalog.loadTable();
        await validateLogIcebergTable(config, table);
        await lease.assert();
        if (String(table.metadata['current-snapshot-id'] ?? '') !== mutation.plan.snapshotId) {
          if (
            table.metadata.snapshots?.some(
              (s) => String(s['snapshot-id']) === mutation.snapshotId
            ) ||
            Object.values(table.metadata.refs ?? {}).some(
              (r) => String(r['snapshot-id']) === mutation.snapshotId
            )
          )
            throw new IcebergCommitUnknownError('log_iceberg_retention_commit_unknown');
          assertIcebergSnapshotLineage(table.metadata, {
            tableUuid: config.tableUuid,
            snapshotId: mutation.plan.snapshotId ?? '',
            sequenceNumber: mutation.plan.sequenceNumber,
          });
          const previous = history(job);
          const next = [...previous, value.deleteState];
          if (
            next.length <= 8 &&
            new TextEncoder().encode(JSON.stringify(next)).length <= 256 * 1024
          ) {
            await ports.admin.execute(
              `UPDATE log_iceberg_retention_jobs SET mutation_history_json=?,mutation_receipt_json=NULL,scan_cursor_json=NULL,snapshot_id=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
              [JSON.stringify(next), id, ...lease.params]
            );
            await lease.assert();
            return { complete: false, processed };
          }
          const proof = await runLogIcebergPhysicalRetentionStep(
            config,
            ports,
            {
              config,
              leaseToken: lease.token,
              retentionId: id,
              tenantKey: input.tenantKey,
              sourceDataset: input.sourceDataset,
              cutoff: job.cutoff,
              deleteIntent: mutation,
              logicalVerified: false,
              retiredDeleteIntents: previous.map(decodeSnapshotDeleteState),
              receiptJson: value.gcReceiptJson,
            },
            () => lease.assert()
          );
          if (proof.retiredOperationIds?.length) {
            const removed = new Set(proof.retiredOperationIds);
            await ports.admin.execute(
              `UPDATE log_iceberg_retention_jobs SET mutation_history_json=? WHERE id=? AND ${lease.predicate}`,
              [
                JSON.stringify(
                  previous.filter((s) => !removed.has(decodeSnapshotDeleteState(s).operationId))
                ),
                id,
                ...lease.params,
              ]
            );
          }
          value.gcReceiptJson = proof.proofJson;
          await save(ports.admin, lease, id, value);
          return { complete: false, processed };
        }
        if (!('update' in mutation)) {
          mutation = await prepareSnapshotRowDelete({
            table,
            store: ports.store(table),
            intent: mutation,
          });
          value.deleteState = encodeSnapshotDeleteState(mutation);
          await save(ports.admin, lease, id, value);
        }
        table = await commitSnapshotRowDelete(
          ports.catalog,
          mutation as SnapshotDeleteMutation,
          () => lease.assert()
        );
      } else table = committed;
      value.logicalVerified = true;
      const verified = JSON.stringify(value);
      if (new TextEncoder().encode(verified).length > 512 * 1024)
        throw new Error('log_iceberg_retention_receipt_budget');
      await ports.admin.batch([
        ...(await prepareLogIcebergStreamObservations(lease, input, mutation.plan.deletes)),
        {
          sql: `UPDATE log_iceberg_retention_jobs SET state='sweeping',mutation_receipt_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
          params: [verified, id, ...lease.params],
        },
      ]);
      await lease.assert();
      processed += mutation.plan.deletes.length;
    }
    if (value?.deleteState && value.logicalVerified) {
      const accepted = decodeSnapshotDeleteState(value.deleteState);
      await lease.assert();
      await new IcebergLifecycle({
        catalog: ports.catalog,
        store: ports.store(table),
        tableLocation: table.metadata.location,
      }).releaseSnapshotPin(
        'authrim-delete-' + accepted.operationId,
        accepted.snapshotId,
        config.tableUuid
      );
      await lease.assert();
    }
    if (!value) {
      let cursor = job.scan_cursor_json
        ? (JSON.parse(job.scan_cursor_json) as SnapshotScanCursor)
        : undefined;
      if (
        cursor &&
        !table.metadata.snapshots?.some((s) => String(s['snapshot-id']) === cursor?.snapshotId)
      )
        cursor = undefined;
      const page = await planSnapshotRowDeletePage(
        {
          table,
          store: ports.store(table),
          tenantKey: input.tenantKey,
          sourceDatasets: [input.sourceDataset],
          nowMs: job.cutoff,
          pageSize: 32,
          cursor,
        },
        'expired'
      );
      if (page.deletes.length) {
        if (page.snapshotId !== String(table.metadata['current-snapshot-id'])) {
          await ports.admin.execute(
            `UPDATE log_iceberg_retention_jobs SET scan_cursor_json=NULL,snapshot_id=NULL WHERE id=? AND ${lease.predicate}`,
            [id, ...lease.params]
          );
          return { complete: false, processed };
        }
        const operationId = await logIcebergDigest(
          JSON.stringify([id, job.cutoff, page.snapshotId, page.deletes])
        );
        value = {
          version: 1,
          logicalVerified: false,
          deleteState: encodeSnapshotDeleteState(
            await createSnapshotDeleteIntent(page, operationId)
          ),
        };
        await save(ports.admin, lease, id, value);
        return { complete: false, processed };
      }
      if (!page.complete) {
        await ports.admin.execute(
          `UPDATE log_iceberg_retention_jobs SET state='sweeping',snapshot_id=?,scan_cursor_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
          [page.snapshotId, JSON.stringify(page.nextCursor), id, ...lease.params]
        );
        await lease.assert();
        return { complete: false, processed };
      }
      value = { version: 1, logicalVerified: true };
      await save(ports.admin, lease, id, value);
    }
    const previous = history(await load(ports.admin, id));
    const proof = await runLogIcebergPhysicalRetentionStep(
      config,
      ports,
      {
        config,
        leaseToken: lease.token,
        retentionId: id,
        tenantKey: input.tenantKey,
        sourceDataset: input.sourceDataset,
        cutoff: job.cutoff,
        deleteIntent: value.deleteState ? decodeSnapshotDeleteState(value.deleteState) : null,
        logicalVerified: value.logicalVerified,
        retiredDeleteIntents: previous.map(decodeSnapshotDeleteState),
        receiptJson: value.gcReceiptJson,
      },
      () => lease.assert()
    );
    if (proof.needsLogicalRescan) {
      await ports.admin.execute(
        `UPDATE log_iceberg_retention_jobs SET state='pending',snapshot_id=NULL,scan_cursor_json=NULL,mutation_receipt_json=NULL WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      await lease.assert();
      return { complete: false, processed };
    }
    const removed = new Set(proof.retiredOperationIds ?? []);
    const retained = previous.filter((s) => !removed.has(decodeSnapshotDeleteState(s).operationId));
    await ports.admin.execute(
      `UPDATE log_iceberg_retention_jobs SET mutation_history_json=? WHERE id=? AND ${lease.predicate}`,
      [JSON.stringify(retained), id, ...lease.params]
    );
    value.gcReceiptJson = proof.proofJson;
    await save(ports.admin, lease, id, value);
    if (!proof.complete || retained.length) return { complete: false, processed };
    if (value.deleteState) {
      await ports.admin.execute(
        `UPDATE log_iceberg_retention_jobs SET mutation_receipt_json=NULL,scan_cursor_json=NULL,snapshot_id=NULL WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      return { complete: false, processed };
    }
    table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    await lease.assert();
    await ports.admin.execute(
      `UPDATE log_iceberg_retention_jobs SET state='completed',snapshot_id=?,scan_cursor_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
      [String(table.metadata['current-snapshot-id'] ?? ''), id, ...lease.params]
    );
    await lease.assert();
    return { complete: true, processed };
  } finally {
    await lease.release();
  }
}
async function jobProgress(admin: DatabaseAdapter, id: string): Promise<string> {
  const row = await admin.queryOne(
    'SELECT state,cutoff,scan_cursor_json,mutation_receipt_json,mutation_history_json FROM log_iceberg_retention_jobs WHERE id=?',
    [id],
    { consistencyClass: 'primary_required' }
  );
  return JSON.stringify(row);
}
export async function runLogIcebergRetention(
  env: LogIcebergCatalogEnv,
  input: { tenantId: string; sourceDataset: string }
): Promise<{ complete: boolean; processed: number; progressed: boolean }> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  assertLogIcebergRemoteConfig(config);
  if (!env.DB_ADMIN) throw new Error('log_iceberg_retention_admin_unavailable');
  const tenantKey = await createLogIcebergWritePort(env, config).resolveTenantKey(input.tenantId);
  const ports = createLogIcebergPhysicalRemovalPorts(env, config);
  ports.admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-retention');
  return runTenantBackupCoveredEffect(
    { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
    logIcebergMutationScope(env, input.tenantId),
    async () => {
      const id = await logIcebergRetentionScopeId(config, { ...input, tenantKey });
      const before = await jobProgress(ports.admin, id);
      const result = await retainLogIcebergScopePage(config, ports, { ...input, tenantKey });
      return {
        ...result,
        progressed: result.processed > 0 || before !== (await jobProgress(ports.admin, id)),
      };
    }
  );
}

/** Inventory committed paths before expiring snapshots. This makes provider
 * compaction sources collectible without guessing ownership from their age. */
export async function maintainLogIcebergMetadataPage(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts
): Promise<{ complete: boolean }> {
  assertLogIcebergRemoteConfig(config);
  const lease = new LogIcebergTableLease(ports.admin, config.tableUuid);
  if (!(await lease.acquire())) return { complete: false };
  try {
    const id = await logIcebergDigest(
      JSON.stringify(['snapshot-maintenance', config.tableUuid, config.generation])
    );
    await ports.admin.execute(
      `INSERT INTO log_iceberg_retention_jobs(id,table_uuid,storage_generation,tenant_id,tenant_key,source_dataset,cutoff,state,created_at,updated_at) SELECT ?,?,?,'__environment__','__environment__','system.snapshot_gc',${LOG_ICEBERG_DB_NOW},'pending',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE ${lease.predicate} ON CONFLICT(id) DO NOTHING`,
      [id, config.tableUuid, config.generation, ...lease.params]
    );
    let job = await load(ports.admin, id);
    if (
      job.tenant_id !== '__environment__' ||
      job.tenant_key !== '__environment__' ||
      job.source_dataset !== 'system.snapshot_gc'
    )
      throw new Error('log_iceberg_metadata_identity_changed');
    if (job.state === 'completed') {
      await ports.admin.execute(
        `UPDATE log_iceberg_retention_jobs SET state='pending',cutoff=${LOG_ICEBERG_DB_NOW},mutation_receipt_json=NULL,snapshot_id=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      job = await load(ports.admin, id);
    }
    const value = receipt(job.mutation_receipt_json) ?? {
      version: 1 as const,
      logicalVerified: true,
    };
    const proof = await runLogIcebergPhysicalMetadataStep(
      config,
      ports,
      {
        leaseToken: lease.token,
        retentionId: id,
        cutoff: job.cutoff,
        receiptJson: value.gcReceiptJson,
      },
      () => lease.assert()
    );
    value.gcReceiptJson = proof.proofJson;
    await save(ports.admin, lease, id, value);
    if (proof.complete) {
      await ports.admin.execute(
        `UPDATE log_iceberg_retention_jobs SET state='completed',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      await lease.assert();
    }
    return { complete: proof.complete };
  } finally {
    await lease.release();
  }
}
export async function runLogIcebergSnapshotMaintenance(
  env: LogIcebergCatalogEnv
): Promise<{ complete: boolean; progressed: boolean }> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  assertLogIcebergRemoteConfig(config);
  return runTenantBackupCoveredEffect(
    { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
    { environment: true },
    async () => {
      const ports = createLogIcebergPhysicalRemovalPorts(env, config);
      const id = await logIcebergDigest(
        JSON.stringify(['snapshot-maintenance', config.tableUuid, config.generation])
      );
      const before = await jobProgress(ports.admin, id);
      const result = await maintainLogIcebergMetadataPage(config, ports);
      return { ...result, progressed: before !== (await jobProgress(ports.admin, id)) };
    }
  );
}
