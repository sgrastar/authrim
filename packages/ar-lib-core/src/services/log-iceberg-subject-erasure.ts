import { LOG_ICEBERG_PII_SUBJECT_ID } from './log-iceberg-erasure-filter';
import { retireLogIcebergRetryObject } from './log-iceberg-retry-marker';
import { createLogIcebergPhysicalErasurePort } from './log-iceberg-physical-erasure';
import { LOG_ICEBERG_DB_NOW, LogIcebergTableLease } from './log-iceberg-lease';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';
import type { DatabaseAdapter } from '../db/adapter';
import { ensureDatabaseAdapter } from '../db';
import {
  planSnapshotRowDeletePage,
  createSnapshotDeleteIntent,
  prepareSnapshotRowDelete,
  commitSnapshotRowDelete,
  reconcileSnapshotRowDelete,
  encodeSnapshotDeleteState,
  decodeSnapshotDeleteState,
  IcebergLifecycle,
  assertIcebergSnapshotLineage,
  IcebergCommitUnknownError,
  type SnapshotDeleteIntent,
  type SnapshotDeleteMutation,
  type SnapshotScanCursor,
  type SnapshotRowDelete,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type IcebergLoadedTable,
} from '@authrim/ar-lib-logging/iceberg';
import { createLogIcebergWritePort } from './log-iceberg-runtime';
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
import { logIcebergDigest, logIcebergRecordId } from './log-iceberg-store';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

export interface LogIcebergSubjectErasureInput {
  tenantId: string;
  sourceDataset: 'pii.pii_log';
  /** The random anonymization-map ID, never a real user ID. */
  subjectId: string;
}
export interface LogIcebergPhysicalErasurePort {
  step(
    input: {
      config: LogIcebergConfig;
      leaseToken: string;
      erasureId: string;
      tenantKey: string;
      subjectId: string;
      deleteIntent: SnapshotDeleteIntent | null;
      logicalVerified: boolean;
      retiredDeleteIntents: readonly SnapshotDeleteIntent[];
      receiptJson?: string;
    },
    assertFence: () => Promise<void>
  ): Promise<{
    complete: boolean;
    proofJson?: string;
    retiredOperationIds?: readonly string[];
    needsLogicalRescan?: boolean;
  }>;
}
export interface LogIcebergSubjectErasurePorts {
  admin: DatabaseAdapter;
  catalog: IcebergCatalogPort;
  store: (table: IcebergLoadedTable) => IcebergObjectStore;
  retryObjects?: Pick<R2Bucket, 'head' | 'put'>;
  physicalErasure?: LogIcebergPhysicalErasurePort;
  capturingTenantKeys?: () => Promise<Set<string>>;
}
interface ErasureRow {
  id: string;
  tenant_id: string;
  tenant_key: string;
  source_dataset: string;
  subject_id: string;
  state: 'pending' | 'sweeping' | 'completed';
  snapshot_id: string | null;
  scan_cursor_json: string | null;
  mutation_receipt_json: string | null;
  mutation_history_json: string;
  removed_count: number;
}
function validate(input: LogIcebergSubjectErasureInput): void {
  if (
    !input.tenantId ||
    input.tenantId.length > 256 ||
    input.sourceDataset !== 'pii.pii_log' ||
    !LOG_ICEBERG_PII_SUBJECT_ID.test(input.subjectId)
  )
    throw new Error('log_iceberg_erasure_scope_invalid');
}

/** The permanent deny is committed before any cleanup attempt. A bounded or
 * interrupted physical sweep cannot republish this anonymous subject. */
export async function eraseLogIcebergSubjectPage(
  config: LogIcebergConfig,
  ports: LogIcebergSubjectErasurePorts,
  input: LogIcebergSubjectErasureInput & { tenantKey: string }
): Promise<{ complete: boolean; removed: number }> {
  validate(input);
  if (!input.tenantKey || input.tenantKey.length > 256)
    throw new Error('log_iceberg_erasure_scope_invalid');
  const id = await logIcebergDigest(
    JSON.stringify([input.tenantId, input.sourceDataset, input.subjectId])
  );
  await ports.admin.execute(
    `INSERT INTO log_iceberg_subject_erasures
    (id,tenant_id,tenant_key,source_dataset,subject_id,state,created_at,updated_at)
    VALUES(?,?,?,?,?,'pending',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000)
    ON CONFLICT(tenant_id,source_dataset,subject_id) DO NOTHING`,
    [id, input.tenantId, input.tenantKey, input.sourceDataset, input.subjectId]
  );
  const saved = await ports.admin.queryOne<ErasureRow>(
    'SELECT * FROM log_iceberg_subject_erasures WHERE id=?',
    [id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !saved ||
    saved.tenant_key !== input.tenantKey ||
    saved.tenant_id !== input.tenantId ||
    saved.subject_id !== input.subjectId ||
    saved.source_dataset !== input.sourceDataset
  )
    throw new Error('log_iceberg_erasure_identity_changed');
  // Local staging has no cold archive witness. The durable deny remains, and
  // no remote physical-erasure proof is invented for this environment.
  if (config.localStagingOnly) return { complete: false, removed: saved.removed_count };
  const lease = new LogIcebergTableLease(ports.admin, config.tableUuid);
  if (!(await lease.acquire())) return { complete: false, removed: saved.removed_count };
  const result = async (complete = false) => ({
    complete,
    removed: (await loadJob(ports.admin, id)).removed_count,
  });
  try {
    let table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    await lease.assert();
    await cleanLocalCopies(ports, lease, saved, input);
    const retriesComplete = await cleanRetryObjects(ports, lease, saved, input);
    let row = await loadJob(ports.admin, id);
    if (
      row.state === 'completed' &&
      row.snapshot_id !== String(table.metadata['current-snapshot-id'] ?? '')
    ) {
      await ports.admin.execute(
        `UPDATE log_iceberg_subject_erasures SET state='pending',snapshot_id=NULL,scan_cursor_json=NULL,mutation_receipt_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      await lease.assert();
      row = await loadJob(ports.admin, id);
    }
    let receipt = row.mutation_receipt_json ? decodeReceipt(row.mutation_receipt_json) : undefined;
    if (receipt?.deleteState && !receipt.logicalVerified) {
      let deletion = decodeSnapshotDeleteState(receipt.deleteState);
      const committed = await reconcileSnapshotRowDelete(ports.catalog, deletion);
      if (!committed) {
        table = await ports.catalog.loadTable();
        await validateLogIcebergTable(config, table);
        await lease.assert();
        if (String(table.metadata['current-snapshot-id']) !== deletion.plan.snapshotId) {
          if (
            table.metadata.snapshots?.some(
              (s) => String(s['snapshot-id']) === deletion.snapshotId
            ) ||
            Object.values(table.metadata.refs ?? {}).some(
              (r) => String(r['snapshot-id']) === deletion.snapshotId
            )
          )
            throw new IcebergCommitUnknownError(
              'log_iceberg_erasure_commit_outside_current_history'
            );
          assertIcebergSnapshotLineage(table.metadata, {
            tableUuid: deletion.plan.tableUuid,
            snapshotId: deletion.plan.snapshotId ?? '',
            sequenceNumber: deletion.plan.sequenceNumber,
          });
          if (!(await retireStaleIntent(ports.admin, lease, row, receipt.deleteState))) {
            if (
              ports.physicalErasure &&
              retriesComplete &&
              !(await localCopiesRemain(ports.admin, input))
            ) {
              const proof = await ports.physicalErasure.step(
                {
                  config,
                  leaseToken: lease.token,
                  erasureId: id,
                  tenantKey: input.tenantKey,
                  subjectId: input.subjectId,
                  deleteIntent: deletion,
                  logicalVerified: false,
                  retiredDeleteIntents: historyIntents(row),
                  receiptJson: receipt.gcReceiptJson,
                },
                () => lease.assert()
              );
              await applyRetiredProof(ports.admin, lease, row, proof);
              if (proof.proofJson) {
                receipt.gcReceiptJson = proof.proofJson;
                await saveReceipt(ports.admin, lease, id, receipt);
              }
            }
          }
          return result();
        }
        if (!('update' in deletion)) {
          deletion = await prepareSnapshotRowDelete({
            table,
            store: ports.store(table),
            intent: deletion,
          });
          receipt.deleteState = encodeSnapshotDeleteState(deletion);
          await saveReceipt(ports.admin, lease, id, receipt);
        }
        table = await commitSnapshotRowDelete(
          ports.catalog,
          deletion as SnapshotDeleteMutation,
          () => lease.assert()
        );
      } else table = committed;
      await lease.assert();
      receipt.logicalVerified = true;
      await markErasedEvents(
        ports.admin,
        lease,
        saved,
        await deletionEvents(deletion.plan.deletes, input.tenantKey, input.sourceDataset),
        receipt
      );
    }
    if (receipt?.deleteState && receipt.logicalVerified) {
      // Admin may have committed the observation+receipt batch before its reply
      // was lost. Releasing its exact pin is independently idempotent on resume.
      const accepted = decodeSnapshotDeleteState(receipt.deleteState);
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
    if (!receipt) {
      // An authenticated fixed-snapshot cursor can survive an unrelated append.
      // A physically expired scan snapshot is re-planned under the same deny.
      let cursor = row.scan_cursor_json ? decodeCursor(row.scan_cursor_json) : undefined;
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
          subjectIds: [input.subjectId],
          nowMs: 0,
          pageSize: 32,
          cursor,
        },
        'subject'
      );
      if (page.deletes.length) {
        // A page may belong to the prior fixed snapshot. Positions are re-planned
        // against current before a mutation rather than replayed after compaction.
        if (page.snapshotId !== String(table.metadata['current-snapshot-id'])) {
          await saveCursor(ports.admin, lease, id, null, null);
          return result();
        }
        const operationId = await logIcebergDigest(
          JSON.stringify([id, page.snapshotId, page.deletes])
        );
        const intent = await createSnapshotDeleteIntent(page, operationId);
        receipt = {
          version: 1,
          deleteState: encodeSnapshotDeleteState(intent),
          logicalVerified: false,
        };
        await saveReceipt(ports.admin, lease, id, receipt);
        return result();
      }
      if (!page.complete) {
        await saveCursor(ports.admin, lease, id, page.snapshotId, page.nextCursor ?? null);
        return result();
      }
      receipt = { version: 1, logicalVerified: true };
      await saveReceipt(ports.admin, lease, id, receipt);
    }
    row = await loadJob(ports.admin, id);
    if (!retriesComplete || (await localCopiesRemain(ports.admin, input))) return result();
    const deletion = receipt.deleteState ? decodeSnapshotDeleteState(receipt.deleteState) : null;
    // No row-level marker is a physical erasure proof. This port also checks
    // historical snapshots/DR pins, shared-file rewrite, and confirmed GC.
    if (!ports.physicalErasure) return result();
    const proof = await ports.physicalErasure.step(
      {
        config,
        leaseToken: lease.token,
        erasureId: id,
        tenantKey: input.tenantKey,
        subjectId: input.subjectId,
        deleteIntent: deletion,
        logicalVerified: receipt.logicalVerified,
        retiredDeleteIntents: historyIntents(row),
        receiptJson: receipt.gcReceiptJson,
      },
      () => lease.assert()
    );
    await lease.assert();
    if (
      proof.proofJson !== undefined &&
      (proof.proofJson.length < 1 || proof.proofJson.length > 128 * 1024)
    )
      throw new Error('log_iceberg_erasure_gc_proof_invalid');
    if (proof.needsLogicalRescan) {
      await ports.admin.execute(
        `UPDATE log_iceberg_subject_erasures SET state='pending',snapshot_id=NULL,scan_cursor_json=NULL,mutation_receipt_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      await lease.assert();
      return result();
    }
    await applyRetiredProof(ports.admin, lease, row, proof);
    receipt.gcReceiptJson = proof.proofJson;
    await saveReceipt(ports.admin, lease, id, receipt);
    if (!proof.complete || historyIntents(await loadJob(ports.admin, id)).length) return result();
    if (!proof.proofJson) throw new Error('log_iceberg_erasure_gc_proof_required');
    // Re-scan after GC. The source deny remains permanent for delayed accepted
    // Pipeline deliveries even after the anonymization mapping is removed.
    table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    if (deletion) {
      await saveCursor(ports.admin, lease, id, null, null);
      await ports.admin.execute(
        `UPDATE log_iceberg_subject_erasures SET mutation_receipt_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
        [id, ...lease.params]
      );
      return result();
    }
    // A deny prevents future sends, but cannot retract already admitted Stream
    // requests. Count every physical copy deleted by an idempotent mutation;
    // a lost response or pre-send crash conservatively leaves an obligation.
    if (
      await ports.admin.queryOne(
        'SELECT 1 FROM log_iceberg_outbox WHERE tenant_id=? AND source_dataset=? AND subject_id=? AND stream_attempt_count>stream_observed_count LIMIT 1',
        [input.tenantId, input.sourceDataset, input.subjectId],
        { consistencyClass: 'primary_required' }
      )
    )
      return result();
    await ports.admin.execute(
      `UPDATE log_iceberg_subject_erasures SET state='completed',snapshot_id=?,scan_cursor_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
      [String(table.metadata['current-snapshot-id'] ?? ''), id, ...lease.params]
    );
    await lease.assert();
    return result(true);
  } finally {
    await lease.release();
  }
}

export async function eraseLogIcebergSubject(
  env: LogIcebergCatalogEnv,
  input: LogIcebergSubjectErasureInput
): Promise<{ complete: boolean; removed: number }> {
  validate(input);
  const config = resolveLogIcebergConfig(env);
  assertLogIcebergActivated(config);
  if (!env.DB_ADMIN) throw new Error('log_iceberg_admin_database_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-erasure');
  const tenantKey = await createLogIcebergWritePort(env, config).resolveTenantKey(input.tenantId);
  let catalog: IcebergCatalogPort | undefined;
  const getCatalog = () => (catalog ??= createLogIcebergCatalog(env, config, 'write'));
  return runTenantBackupCoveredEffect(
    { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
    { tenantId: input.tenantId },
    () =>
      eraseLogIcebergSubjectPage(
        config,
        {
          admin,
          catalog: {
            loadTable: () => getCatalog().loadTable(),
            commit: (update) => getCatalog().commit(update),
          },
          store: (table) => createLogIcebergObjectStore(env, table),
          retryObjects: env.LOG_ARCHIVE,
          physicalErasure: {
            step: (value, assertFence) =>
              createLogIcebergPhysicalErasurePort(env, config).step(value, assertFence),
          },
        },
        { ...input, tenantKey }
      )
  );
}

interface ErasureMutationReceipt {
  version: 1;
  deleteState?: string;
  logicalVerified: boolean;
  gcReceiptJson?: string;
}
function decodeReceipt(text: string): ErasureMutationReceipt {
  if (text.length > 512 * 1024 || new TextEncoder().encode(text).byteLength > 512 * 1024)
    throw new Error('log_iceberg_erasure_state_invalid');
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('logicalVerified' in value) ||
    typeof value.logicalVerified !== 'boolean' ||
    ('deleteState' in value && typeof value.deleteState !== 'string') ||
    ('gcReceiptJson' in value && typeof value.gcReceiptJson !== 'string')
  )
    throw new Error('log_iceberg_erasure_state_invalid');
  return value as ErasureMutationReceipt;
}
function decodeCursor(text: string): SnapshotScanCursor {
  if (text.length > 32 * 1024) throw new Error('log_iceberg_erasure_cursor_invalid');
  const cursor: unknown = JSON.parse(text);
  if (!cursor || typeof cursor !== 'object' || !('version' in cursor) || cursor.version !== 1)
    throw new Error('log_iceberg_erasure_cursor_invalid');
  return cursor as SnapshotScanCursor;
}
async function loadJob(admin: DatabaseAdapter, id: string): Promise<ErasureRow> {
  const row = await admin.queryOne<ErasureRow>(
    'SELECT * FROM log_iceberg_subject_erasures WHERE id=?',
    [id],
    { consistencyClass: 'primary_required' }
  );
  if (!row) throw new Error('log_iceberg_erasure_state_missing');
  return row;
}
async function saveReceipt(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  id: string,
  receipt: ErasureMutationReceipt
): Promise<void> {
  const text = JSON.stringify(receipt);
  if (text.length > 512 * 1024 || new TextEncoder().encode(text).byteLength > 512 * 1024)
    throw new Error('log_iceberg_erasure_state_invalid');
  await admin.execute(
    `UPDATE log_iceberg_subject_erasures SET state='sweeping',mutation_receipt_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
    [text, id, ...lease.params]
  );
  await lease.assert();
}
async function saveCursor(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  id: string,
  snapshot: string | null,
  cursor: SnapshotScanCursor | null
): Promise<void> {
  await admin.execute(
    `UPDATE log_iceberg_subject_erasures SET state='sweeping',snapshot_id=?,scan_cursor_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
    [snapshot, cursor ? JSON.stringify(cursor) : null, id, ...lease.params]
  );
  await lease.assert();
}
interface ErasedEvent {
  id: string;
  hmac: string;
  expiry: number | null;
}
async function deletionEvents(
  rows: readonly SnapshotRowDelete[],
  tenantKey: string,
  sourceDataset: string
): Promise<ErasedEvent[]> {
  const events: ErasedEvent[] = [];
  for (const row of rows)
    events.push({
      id: await logIcebergRecordId({
        tenant_key: tenantKey,
        source_dataset: sourceDataset,
        event_id: row.eventId,
      }),
      hmac: row.payloadHmac,
      expiry: row.expiresAt,
    });
  return events;
}
function eventStatements(
  lease: LogIcebergTableLease,
  job: ErasureRow,
  values: readonly ErasedEvent[]
) {
  const unique = new Map<string, ErasedEvent>();
  for (const value of values) {
    const existing = unique.get(value.id);
    if (existing && (existing.hmac !== value.hmac || existing.expiry !== value.expiry))
      throw new Error('log_iceberg_event_id_collision');
    unique.set(value.id, value);
  }
  const events = [...unique.values()];
  if (
    events.length > 128 ||
    events.some(
      (v) =>
        !/^[a-f0-9]{64}$/.test(v.id) ||
        !/^[a-f0-9]{64}$/.test(v.hmac) ||
        (v.expiry !== null && (!Number.isSafeInteger(v.expiry) || v.expiry < 0))
    )
  )
    throw new Error('log_iceberg_erasure_events_invalid');
  const json = JSON.stringify(events);
  return [
    {
      sql: `UPDATE log_iceberg_subject_erasures SET removed_count=removed_count+(SELECT COUNT(*) FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM log_iceberg_event_receipts r WHERE r.id=json_extract(e.value,'$.id') AND r.state='erased')),updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
      params: [json, job.id, ...lease.params],
    },
    {
      sql: `INSERT INTO log_iceberg_event_receipts(id,tenant_id,source_dataset,payload_hmac,expires_at,state,created_at)
       SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.hmac'),json_extract(value,'$.expiry'),'erased',${LOG_ICEBERG_DB_NOW} FROM json_each(?) WHERE ${lease.predicate}
       ON CONFLICT(id) DO UPDATE SET state=CASE WHEN log_iceberg_event_receipts.tenant_id=excluded.tenant_id AND log_iceberg_event_receipts.source_dataset=excluded.source_dataset AND log_iceberg_event_receipts.payload_hmac=excluded.payload_hmac AND log_iceberg_event_receipts.expires_at IS excluded.expires_at THEN 'erased' ELSE NULL END`,
      params: [job.tenant_id, job.source_dataset, json, ...lease.params],
    },
  ];
}
function streamObservationStatement(
  lease: LogIcebergTableLease,
  scope: { tenantId: string; sourceDataset: string },
  events: readonly ErasedEvent[]
) {
  if (
    events.length > 128 ||
    events.some(
      (e) =>
        !/^[a-f0-9]{64}$/.test(e.id) ||
        !/^[a-f0-9]{64}$/.test(e.hmac) ||
        (e.expiry !== null && (!Number.isSafeInteger(e.expiry) || e.expiry < 0))
    )
  )
    throw new Error('log_iceberg_stream_observation_invalid');
  const copies = new Map<string, ErasedEvent & { copies: number }>();
  for (const event of events) {
    const previous = copies.get(event.id);
    if (previous && (previous.hmac !== event.hmac || previous.expiry !== event.expiry))
      throw new Error('log_iceberg_event_id_collision');
    copies.set(event.id, { ...event, copies: (previous?.copies ?? 0) + 1 });
  }
  const json = JSON.stringify([...copies.values()]);
  return {
    sql: `UPDATE log_iceberg_outbox SET stream_observed_count=CASE WHEN EXISTS(SELECT 1 FROM json_each(?) e WHERE json_extract(e.value,'$.id')=log_iceberg_outbox.id AND json_extract(e.value,'$.hmac')=log_iceberg_outbox.payload_hmac AND json_extract(e.value,'$.expiry') IS log_iceberg_outbox.expires_at) THEN stream_observed_count+(SELECT json_extract(e.value,'$.copies') FROM json_each(?) e WHERE json_extract(e.value,'$.id')=log_iceberg_outbox.id) ELSE NULL END WHERE id IN(SELECT json_extract(value,'$.id') FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND stream_obligation_at IS NOT NULL AND ${lease.predicate}`,
    params: [json, json, json, scope.tenantId, scope.sourceDataset, ...lease.params],
  };
}
/** Add to the SAME atomic batch as an accepted mutation's verified receipt. */
export async function prepareLogIcebergStreamObservations(
  lease: LogIcebergTableLease,
  scope: { tenantId: string; tenantKey: string; sourceDataset: string },
  deletes: readonly SnapshotRowDelete[]
) {
  return [
    streamObservationStatement(
      lease,
      scope,
      await deletionEvents(deletes, scope.tenantKey, scope.sourceDataset)
    ),
  ];
}
async function markErasedEvents(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  job: ErasureRow,
  events: readonly ErasedEvent[],
  receipt: ErasureMutationReceipt
): Promise<void> {
  const saved = JSON.stringify(receipt);
  if (new TextEncoder().encode(saved).length > 512 * 1024)
    throw new Error('log_iceberg_erasure_state_invalid');
  await admin.batch([
    ...eventStatements(lease, job, events),
    streamObservationStatement(
      lease,
      { tenantId: job.tenant_id, sourceDataset: job.source_dataset },
      events
    ),
    {
      sql: `UPDATE log_iceberg_subject_erasures SET state='sweeping',mutation_receipt_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
      params: [saved, job.id, ...lease.params],
    },
  ]);
  await lease.assert();
}
async function cleanLocalCopies(
  ports: LogIcebergSubjectErasurePorts,
  lease: LogIcebergTableLease,
  job: ErasureRow,
  input: LogIcebergSubjectErasureInput
): Promise<void> {
  const rows = await ports.admin.query<{
    id: string;
    payload_hmac: string;
    expires_at: number | null;
    batch_id: string | null;
  }>(
    `SELECT id,payload_hmac,expires_at,batch_id FROM log_iceberg_records WHERE tenant_id=? AND source_dataset=? AND json_extract(header_json,'$.subject_id')=? ORDER BY id LIMIT 32`,
    [input.tenantId, input.sourceDataset, input.subjectId],
    { consistencyClass: 'primary_required' }
  );
  const outbox = await ports.admin.query<{
    id: string;
    payload_hmac: string;
    expires_at: number | null;
  }>(
    `SELECT id,payload_hmac,expires_at FROM log_iceberg_outbox WHERE tenant_id=? AND source_dataset=? AND subject_id=? AND state!='erased' ORDER BY id LIMIT 32`,
    [input.tenantId, input.sourceDataset, input.subjectId],
    { consistencyClass: 'primary_required' }
  );
  const ids = JSON.stringify(rows.map((r) => r.id));
  const batches = JSON.stringify([
    ...new Set(rows.flatMap((r) => (r.batch_id ? [r.batch_id] : []))),
  ]);
  const outboxIds = JSON.stringify(outbox.map((r) => r.id));
  const statements = eventStatements(
    lease,
    job,
    [...rows, ...outbox].map((r) => ({ id: r.id, hmac: r.payload_hmac, expiry: r.expires_at }))
  );
  statements.push(
    {
      sql: `UPDATE log_iceberg_export_batches SET state='done',last_error_code=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND ${lease.predicate}`,
      params: [
        'log_iceberg_erasure_' + job.id,
        batches,
        input.tenantId,
        input.sourceDataset,
        ...lease.params,
      ],
    },
    {
      sql: `UPDATE log_iceberg_records SET batch_id=NULL WHERE batch_id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND ${lease.predicate}`,
      params: [batches, input.tenantId, input.sourceDataset, ...lease.params],
    },
    {
      sql: `DELETE FROM log_iceberg_record_parts WHERE record_id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND ${lease.predicate}`,
      params: [ids, input.tenantId, ...lease.params],
    },
    {
      sql: `DELETE FROM log_iceberg_records WHERE id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND json_extract(header_json,'$.subject_id')=? AND ${lease.predicate}`,
      params: [ids, input.tenantId, input.sourceDataset, input.subjectId, ...lease.params],
    },
    {
      sql: `UPDATE log_iceberg_outbox SET state='erased',updated_at=${LOG_ICEBERG_DB_NOW} WHERE id IN(SELECT value FROM json_each(?)) AND tenant_id=? AND source_dataset=? AND subject_id=? AND ${lease.predicate}`,
      params: [outboxIds, input.tenantId, input.sourceDataset, input.subjectId, ...lease.params],
    }
  );
  await ports.admin.batch(statements);
  await lease.assert();
}
async function localCopiesRemain(
  admin: DatabaseAdapter,
  input: LogIcebergSubjectErasureInput
): Promise<boolean> {
  return (
    Boolean(
      await admin.queryOne(
        `SELECT 1 AS present FROM log_iceberg_records WHERE tenant_id=? AND source_dataset=? AND json_extract(header_json,'$.subject_id')=? LIMIT 1`,
        [input.tenantId, input.sourceDataset, input.subjectId],
        { consistencyClass: 'primary_required' }
      )
    ) ||
    Boolean(
      await admin.queryOne(
        `SELECT 1 AS present FROM log_iceberg_outbox WHERE tenant_id=? AND source_dataset=? AND subject_id=? AND (state!='erased' OR payload_erased_at IS NULL) LIMIT 1`,
        [input.tenantId, input.sourceDataset, input.subjectId],
        { consistencyClass: 'primary_required' }
      )
    )
  );
}
async function cleanRetryObjects(
  ports: LogIcebergSubjectErasurePorts,
  lease: LogIcebergTableLease,
  job: ErasureRow,
  input: LogIcebergSubjectErasureInput
): Promise<boolean> {
  const rows = await ports.admin.query<{
    id: string;
    storage_generation: string;
    payload_hmac: string;
    payload_key: string;
    payload_digest: string | null;
    payload_bytes: number | null;
  }>(
    `SELECT id,storage_generation,payload_hmac,payload_key,payload_digest,payload_bytes FROM log_iceberg_outbox WHERE tenant_id=? AND source_dataset=? AND subject_id=? AND state='erased' AND payload_erased_at IS NULL ORDER BY id LIMIT 32`,
    [input.tenantId, input.sourceDataset, input.subjectId],
    { consistencyClass: 'primary_required' }
  );
  if (!rows.length) return true;
  const capturing = await (ports.capturingTenantKeys
    ? ports.capturingTenantKeys()
    : listCapturingTenantBackupTenantKeys(ports.admin));
  if (capturing.has(job.tenant_key) || !ports.retryObjects) return false;
  for (const row of rows) {
    const confirmed = await retireLogIcebergRetryObject(
      ports.retryObjects,
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
    if (!confirmed) return false;
    await ports.admin.execute(
      `UPDATE log_iceberg_outbox SET payload_erased_at=${LOG_ICEBERG_DB_NOW},updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND tenant_id=? AND state='erased' AND payload_key=? AND storage_generation=? AND payload_hmac=? AND ${lease.predicate}`,
      [
        row.id,
        input.tenantId,
        row.payload_key,
        row.storage_generation,
        row.payload_hmac,
        ...lease.params,
      ]
    );
    await lease.assert();
  }
  return rows.length < 32;
}

function historyTexts(row: ErasureRow): string[] {
  if (new TextEncoder().encode(row.mutation_history_json).byteLength > 256 * 1024)
    throw new Error('log_iceberg_erasure_history_invalid');
  const value: unknown = JSON.parse(row.mutation_history_json);
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some((item: unknown) => typeof item !== 'string' || item.length > 256 * 1024)
  )
    throw new Error('log_iceberg_erasure_history_invalid');
  return value as string[];
}
function historyIntents(row: ErasureRow): SnapshotDeleteIntent[] {
  return historyTexts(row).map(decodeSnapshotDeleteState);
}
async function retireStaleIntent(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  row: ErasureRow,
  text: string
): Promise<boolean> {
  const history = historyTexts(row);
  const intent = decodeSnapshotDeleteState(text);
  if (!history.some((value) => decodeSnapshotDeleteState(value).operationId === intent.operationId))
    history.push(text);
  const json = JSON.stringify(history);
  if (history.length > 8 || new TextEncoder().encode(json).byteLength > 256 * 1024) return false;
  await admin.execute(
    `UPDATE log_iceberg_subject_erasures SET mutation_history_json=?,state='pending',snapshot_id=NULL,scan_cursor_json=NULL,mutation_receipt_json=NULL,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
    [json, row.id, ...lease.params]
  );
  await lease.assert();
  return true;
}
async function applyRetiredProof(
  admin: DatabaseAdapter,
  lease: LogIcebergTableLease,
  row: ErasureRow,
  proof: { proofJson?: string; retiredOperationIds?: readonly string[] }
): Promise<void> {
  if (!proof.retiredOperationIds?.length) return;
  const ids = proof.retiredOperationIds;
  const history = historyTexts(row);
  const known = new Set(history.map((text) => decodeSnapshotDeleteState(text).operationId));
  if (
    !proof.proofJson ||
    proof.proofJson.length > 128 * 1024 ||
    ids.length > 8 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !known.has(id))
  )
    throw new Error('log_iceberg_erasure_retirement_proof_invalid');
  const json = JSON.stringify(
    history.filter((text) => !ids.includes(decodeSnapshotDeleteState(text).operationId))
  );
  await admin.execute(
    `UPDATE log_iceberg_subject_erasures SET mutation_history_json=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE id=? AND ${lease.predicate}`,
    [json, row.id, ...lease.params]
  );
  await lease.assert();
}
