import {
  ScheduledIcebergWriter,
  IcebergLifecycle,
  verifySnapshotBatch,
  assertIcebergSnapshotLineage,
  type IcebergBatchCheckpoint,
  type IcebergBatchJournal,
  type IcebergCatalogPort,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from '@authrim/ar-lib-logging/iceberg';
import { ensureDatabaseAdapter } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import {
  assertLogIcebergActivated,
  assertLogIcebergRemoteConfig,
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
  SqlLogIcebergRecordStore,
  logIcebergPublicationVisibleSql,
  logIcebergRecordId,
  type LogIcebergStagedHead,
} from './log-iceberg-store';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

interface SelectedRecord {
  id: string;
  payload_hmac: string;
  envelope_digest: string;
}
interface ExportBatch {
  id: string;
  storage_generation: string;
  tenant_id: string;
  tenant_key: string;
  source_dataset: string;
  record_ids_json: string;
  checkpoint_json: string | null;
  receipt_json: string | null;
  state: 'selected' | 'committed' | 'verified' | 'done';
}
export interface LogIcebergExportPorts {
  admin: DatabaseAdapter;
  catalog: IcebergCatalogPort;
  store: (table: Awaited<ReturnType<IcebergCatalogPort['loadTable']>>) => IcebergObjectStore;
}
function selections(batch: ExportBatch): SelectedRecord[] {
  const value: unknown = JSON.parse(batch.record_ids_json);
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new Error('log_iceberg_batch_selection_invalid');
  const selected: SelectedRecord[] = [];
  for (const item of value as unknown[]) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !('payload_hmac' in item) ||
      typeof item.payload_hmac !== 'string' ||
      !('envelope_digest' in item) ||
      typeof item.envelope_digest !== 'string' ||
      ![item.id, item.payload_hmac, item.envelope_digest].every((v) => /^[a-f0-9]{64}$/.test(v))
    )
      throw new Error('log_iceberg_batch_selection_invalid');
    selected.push({
      id: item.id,
      payload_hmac: item.payload_hmac,
      envelope_digest: item.envelope_digest,
    });
  }
  if (new Set(selected.map((item) => item.id)).size !== selected.length)
    throw new Error('log_iceberg_batch_selection_invalid');
  return selected;
}
function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z][a-z0-9_]{0,95}$/.test(error.message)
    ? error.message
    : 'log_iceberg_export_failed';
}

/** One bounded batch per invocation; an uncertain tenant backs off while other
 * scopes can progress. All journal/source writes check the database lease clock. */
export async function exportLogIcebergBatch(
  config: LogIcebergConfig,
  ports: LogIcebergExportPorts,
  probe?: { eventId: string; tenantKey: string }
): Promise<{ leased: boolean; moved: number; batchId?: string }> {
  assertLogIcebergRemoteConfig(config);
  if (
    probe &&
    (!/^log_archive_probe_v1:[a-f0-9-]{36}:[1-9][0-9]{0,8}$/.test(probe.eventId) ||
      !probe.tenantKey)
  )
    throw new Error('log_iceberg_probe_scope_invalid');
  if (config.mode !== 'scheduled' || config.dbRetentionDays === null)
    throw new Error('log_iceberg_scheduled_mode_required');
  const lease = new LogIcebergTableLease(ports.admin, config.tableUuid);
  if (!(await lease.acquire())) return { leased: false, moved: 0 };
  let batch: ExportBatch | null = null;
  try {
    batch = await ports.admin.queryOne<ExportBatch>(
      `SELECT * FROM log_iceberg_export_batches WHERE storage_generation=? AND state!='done' AND next_attempt_at<=${LOG_ICEBERG_DB_NOW}${probe ? " AND tenant_id='platform' AND source_dataset='runtime.admin_job_events' AND json_array_length(record_ids_json)=1 AND json_extract(record_ids_json,'$[0].id')=?" : ''} ORDER BY updated_at,id LIMIT 1`,
      [
        config.generation,
        ...(probe
          ? [
              await logIcebergRecordId({
                tenant_key: probe.tenantKey,
                source_dataset: 'runtime.admin_job_events',
                event_id: probe.eventId,
              }),
            ]
          : []),
      ],
      { consistencyClass: 'primary_required' }
    );
    if (!batch) {
      const first = await ports.admin.queryOne<LogIcebergStagedHead>(
        `SELECT * FROM log_iceberg_records r WHERE storage_generation=? AND ${logIcebergPublicationVisibleSql('r')} AND batch_id IS NULL AND ${probe ? "r.tenant_id='platform' AND r.tenant_key=? AND r.source_dataset='runtime.admin_job_events' AND r.event_id=?" : `ingested_at<=${LOG_ICEBERG_DB_NOW}-?`} AND NOT EXISTS(SELECT 1 FROM log_iceberg_export_batches b WHERE b.storage_generation=r.storage_generation AND b.tenant_key=r.tenant_key AND b.source_dataset=r.source_dataset AND b.state!='done') ORDER BY ingested_at,id LIMIT 1`,
        [
          config.generation,
          ...(probe ? [probe.tenantKey, probe.eventId] : [config.dbRetentionDays * 86400000]),
        ],
        { consistencyClass: 'primary_required' }
      );
      if (!first) return { leased: true, moved: 0 };
      const candidates = probe
        ? [first]
        : await ports.admin.query<LogIcebergStagedHead>(
            `SELECT * FROM log_iceberg_records WHERE storage_generation=? AND ${logIcebergPublicationVisibleSql()} AND tenant_id=? AND tenant_key=? AND source_dataset=? AND batch_id IS NULL AND ingested_at<=${LOG_ICEBERG_DB_NOW}-? ORDER BY ingested_at,id LIMIT 100`,
            [
              config.generation,
              first.tenant_id,
              first.tenant_key,
              first.source_dataset,
              config.dbRetentionDays * 86400000,
            ],
            { consistencyClass: 'primary_required' }
          );
      let bytes = 0;
      const heads: LogIcebergStagedHead[] = [];
      for (const head of candidates) {
        if (
          !Number.isSafeInteger(head.body_bytes) ||
          head.body_bytes < 1 ||
          head.body_bytes > 4194304
        )
          throw new Error('log_iceberg_staging_invalid');
        if (
          bytes + head.body_bytes + new TextEncoder().encode(head.header_json).byteLength + 1000 >
          4 * 1024 * 1024
        )
          break;
        bytes += head.body_bytes + new TextEncoder().encode(head.header_json).byteLength + 1000;
        heads.push(head);
      }
      if (!heads.length) throw new Error('log_iceberg_export_row_too_large');
      const id = crypto.randomUUID();
      const selected = JSON.stringify(
        heads.map(({ id, payload_hmac, envelope_digest }) => ({
          id,
          payload_hmac,
          envelope_digest,
        }))
      );
      const matching = `SELECT COUNT(*) FROM log_iceberg_records r JOIN json_each(?) j ON r.id=json_extract(j.value,'$.id') AND r.payload_hmac=json_extract(j.value,'$.payload_hmac') AND r.envelope_digest=json_extract(j.value,'$.envelope_digest') WHERE r.batch_id IS NULL AND r.storage_generation=? AND r.tenant_id=? AND r.tenant_key=? AND r.source_dataset=?`;
      const claim = await ports.admin.batch([
        {
          sql: `INSERT INTO log_iceberg_export_batches(id,storage_generation,tenant_id,tenant_key,source_dataset,record_ids_json,state,created_at,updated_at) SELECT ?,?,?,?,?,?,'selected',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE ${lease.predicate} AND (${matching})=?`,
          params: [
            id,
            config.generation,
            first.tenant_id,
            first.tenant_key,
            first.source_dataset,
            selected,
            ...lease.params,
            selected,
            config.generation,
            first.tenant_id,
            first.tenant_key,
            first.source_dataset,
            heads.length,
          ],
        },
        {
          sql: `UPDATE log_iceberg_records SET batch_id=? WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND batch_id IS NULL AND EXISTS(SELECT 1 FROM log_iceberg_export_batches WHERE id=?) AND ${lease.predicate}`,
          params: [id, selected, id, ...lease.params],
        },
        {
          sql: `UPDATE log_iceberg_export_batches SET record_ids_json=CASE WHEN
          (SELECT COUNT(*) FROM log_iceberg_records WHERE batch_id=?)=? THEN record_ids_json ELSE NULL END WHERE id=?`,
          params: [id, heads.length, id],
        },
      ]);
      if (claim[0]?.rowsAffected !== 1 || claim[1]?.rowsAffected !== heads.length)
        throw new Error('log_iceberg_selection_changed');
      batch = await ports.admin.queryOne<ExportBatch>(
        'SELECT * FROM log_iceberg_export_batches WHERE id=?',
        [id],
        { consistencyClass: 'primary_required' }
      );
    }
    if (!batch) throw new Error('log_iceberg_batch_missing');
    const currentBatch = batch;
    const selected = selections(currentBatch);
    const heads = await ports.admin.query<LogIcebergStagedHead>(
      `SELECT * FROM log_iceberg_records WHERE batch_id=? AND ${logIcebergPublicationVisibleSql()} ORDER BY ingested_at,id`,
      [currentBatch.id],
      { consistencyClass: 'primary_required' }
    );
    if (
      heads.length !== selected.length ||
      heads.some(
        (head) =>
          !selected.some(
            (item) =>
              item.id === head.id &&
              item.payload_hmac === head.payload_hmac &&
              item.envelope_digest === head.envelope_digest
          ) ||
          head.tenant_id !== currentBatch.tenant_id ||
          head.tenant_key !== currentBatch.tenant_key ||
          head.source_dataset !== currentBatch.source_dataset ||
          head.storage_generation !== config.generation
      )
    )
      throw new Error('log_iceberg_source_changed');
    const records = await new SqlLogIcebergRecordStore(ports.admin).read(heads);
    if (records.length !== heads.length) throw new Error('log_iceberg_source_changed');
    const previousAnchors = await ports.admin.query<{
      table_uuid: string;
      snapshot_id: string;
      minimum_sequence_number: number;
    }>(
      'SELECT table_uuid,snapshot_id,minimum_sequence_number FROM log_iceberg_read_watermarks WHERE table_uuid=?',
      [config.tableUuid],
      { consistencyClass: 'primary_required' }
    );
    const assertRequiredHistory = (metadata: IcebergLoadedTable['metadata']) => {
      for (const anchor of previousAnchors)
        assertIcebergSnapshotLineage(metadata, {
          tableUuid: anchor.table_uuid,
          snapshotId: anchor.snapshot_id,
          sequenceNumber: anchor.minimum_sequence_number,
        });
    };
    const catalog: IcebergCatalogPort = {
      async loadTable() {
        const table = await ports.catalog.loadTable();
        await validateLogIcebergTable(config, table);
        assertRequiredHistory(table.metadata);
        return table;
      },
      async commit(update) {
        await lease.assert();
        const table = await ports.catalog.commit(update);
        await validateLogIcebergTable(config, table);
        assertRequiredHistory(table.metadata);
        return table;
      },
    };
    const table = await catalog.loadTable();
    const store = ports.store(table);
    const journal: IcebergBatchJournal = {
      async assertFence(id, fence) {
        if (id !== currentBatch.id || fence !== lease.token)
          throw new Error('log_iceberg_stale_fence');
        await lease.assert();
      },
      async loadOrCreate(candidate, fence) {
        await this.assertFence(candidate.batchId, fence);
        const json = JSON.stringify(candidate);
        await ports.admin.execute(
          `UPDATE log_iceberg_export_batches SET checkpoint_json=COALESCE(checkpoint_json,?),updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
          [json, currentBatch.id, ...lease.params]
        );
        await lease.assert();
        const saved = await ports.admin.queryOne<{ checkpoint_json: string }>(
          'SELECT checkpoint_json FROM log_iceberg_export_batches WHERE id=?',
          [currentBatch.id],
          { consistencyClass: 'primary_required' }
        );
        if (!saved?.checkpoint_json) throw new Error('log_iceberg_checkpoint_missing');
        return JSON.parse(saved.checkpoint_json) as IcebergBatchCheckpoint;
      },
      async markCommitted(receipt, fence) {
        await this.assertFence(receipt.batchId, fence);
        const result = await ports.admin.execute(
          `UPDATE log_iceberg_export_batches SET state='committed',receipt_json=?,checkpoint_json=json_set(checkpoint_json,'$.state','committed','$.sequenceNumber',?),updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND json_extract(checkpoint_json,'$.batchDigest')=? AND ${lease.predicate}`,
          [
            JSON.stringify(receipt),
            receipt.sequenceNumber,
            currentBatch.id,
            receipt.batchDigest,
            ...lease.params,
          ]
        );
        if (result.rowsAffected !== 1) throw new Error('log_iceberg_stale_fence');
      },
    };
    const receipt = await new ScheduledIcebergWriter({
      catalog,
      store,
      tableLocation: table.metadata.location,
      storageGeneration: config.generation,
      journal,
    }).appendBatch({ batchId: currentBatch.id, fence: lease.token, records });
    const fresh = await catalog.loadTable();
    await validateLogIcebergTable(config, fresh);
    assertRequiredHistory(fresh.metadata);
    // Read precisely the pinned committed batch through the same Parquet/delete reader.
    const verification = await verifySnapshotBatch({
      table: fresh,
      store,
      snapshotId: receipt.snapshotId,
      tenantKey: currentBatch.tenant_key,
      sourceDatasets: [currentBatch.source_dataset],
      expectedRecords: records,
      nowMs: Date.now(),
    });
    const batchAnchor = {
      tableUuid: config.tableUuid,
      snapshotId: receipt.snapshotId,
      sequenceNumber: verification.sequenceNumber,
    };
    assertIcebergSnapshotLineage(fresh.metadata, batchAnchor);
    // Keep this batch in current history through pin release as well. A rollback
    // after the DB commit must leave the tagged recovery copy intact.
    previousAnchors.push({
      table_uuid: batchAnchor.tableUuid,
      snapshot_id: batchAnchor.snapshotId,
      minimum_sequence_number: batchAnchor.sequenceNumber,
    });
    await journal.assertFence(receipt.batchId, lease.token);
    const receiptJson = JSON.stringify(receipt);
    const ready = await ports.admin.execute(
      `UPDATE log_iceberg_export_batches SET state='verified',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND receipt_json=? AND ${lease.predicate}`,
      [currentBatch.id, receiptJson, ...lease.params]
    );
    if (ready.rowsAffected !== 1) throw new Error('log_iceberg_stale_fence');
    // A readable tagged snapshot is insufficient if current main has forked.
    // Recheck both the previous durable history and this new batch immediately
    // before atomically advancing the DB watermark and removing its source.
    const beforeDelete = await catalog.loadTable();
    await validateLogIcebergTable(config, beforeDelete);
    assertRequiredHistory(beforeDelete.metadata);
    assertIcebergSnapshotLineage(beforeDelete.metadata, batchAnchor);
    const proof = `EXISTS(SELECT 1 FROM log_iceberg_export_batches WHERE id=? AND state='verified' AND receipt_json=?) AND ${lease.predicate} AND ${LOG_ICEBERG_DB_NOW}<?`;
    const proofParams = [currentBatch.id, receiptJson, ...lease.params, receipt.pinExpiresAt];
    const deleted = await ports.admin.batch([
      {
        sql: `UPDATE log_iceberg_export_batches SET state=CASE WHEN ${proof} AND
        (SELECT COUNT(*) FROM log_iceberg_records r JOIN json_each(?) j ON r.id=json_extract(j.value,'$.id') AND r.payload_hmac=json_extract(j.value,'$.payload_hmac') AND r.envelope_digest=json_extract(j.value,'$.envelope_digest') WHERE r.batch_id=?)=?
        THEN state ELSE NULL END WHERE id=?`,
        params: [
          ...proofParams,
          currentBatch.record_ids_json,
          currentBatch.id,
          records.length,
          currentBatch.id,
        ],
      },
      {
        sql: `INSERT INTO log_iceberg_read_watermarks(id,table_uuid,minimum_sequence_number,snapshot_id,updated_at) SELECT ?,?,?,?,${LOG_ICEBERG_DB_NOW} WHERE ${proof}
        ON CONFLICT(id) DO UPDATE SET minimum_sequence_number=MAX(log_iceberg_read_watermarks.minimum_sequence_number,excluded.minimum_sequence_number),snapshot_id=CASE WHEN excluded.minimum_sequence_number>=log_iceberg_read_watermarks.minimum_sequence_number THEN excluded.snapshot_id ELSE log_iceberg_read_watermarks.snapshot_id END,updated_at=excluded.updated_at`,
        params: [
          config.tableUuid,
          config.tableUuid,
          verification.sequenceNumber,
          receipt.snapshotId,
          ...proofParams,
        ],
      },
      {
        sql: `DELETE FROM log_iceberg_records WHERE batch_id=? AND id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${proof}`,
        params: [currentBatch.id, currentBatch.record_ids_json, ...proofParams],
      },
      {
        sql: `UPDATE log_iceberg_event_receipts SET state='published' WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND ${proof}`,
        params: [currentBatch.record_ids_json, ...proofParams],
      },
      {
        sql: `UPDATE log_iceberg_export_batches SET state='done',last_error_code=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${proof}`,
        params: [currentBatch.id, ...proofParams],
      },
    ]);
    if (
      deleted[2]?.rowsAffected !== records.length ||
      deleted[3]?.rowsAffected !== records.length ||
      deleted[4]?.rowsAffected !== 1
    )
      throw new Error('log_iceberg_source_delete_not_confirmed');
    await new IcebergLifecycle({
      catalog,
      store,
      tableLocation: table.metadata.location,
    }).releaseBatchPin(receipt, true);
    return { leased: true, moved: records.length, batchId: currentBatch.id };
  } catch (error) {
    if (batch)
      await ports.admin.execute(
        `UPDATE log_iceberg_export_batches SET attempt_count=attempt_count+1,last_error_code=?,next_attempt_at=${LOG_ICEBERG_DB_NOW}+600000,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND state!='done' AND ${lease.predicate}`,
        [errorCode(error), batch.id, ...lease.params]
      );
    throw error;
  } finally {
    await lease.release();
  }
}

export async function runLogIcebergExport(
  env: LogIcebergCatalogEnv
): Promise<{ leased: boolean; moved: number; batchId?: string }> {
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (config.mode === 'pipeline') return { leased: false, moved: 0 };
  if (!env.DB_ADMIN) throw new Error('log_iceberg_admin_database_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-export');
  return runTenantBackupCoveredEffect(
    { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
    { environment: true },
    () =>
      exportLogIcebergBatch(config, {
        admin,
        catalog: createLogIcebergCatalog(env, config, 'write'),
        store: (table) => createLogIcebergObjectStore(env, table),
      })
  );
}
