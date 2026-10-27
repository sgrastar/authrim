import {
  IcebergLifecycle,
  IcebergBudgetError,
  IcebergCatalogConflictError,
  advanceIcebergMainForGc,
  assertIcebergSnapshotLineage,
  assertLogArchiveRewriteBudget,
  scanSnapshotSubjectFilesPage,
  scanSnapshotExpiredFilesPage,
  planSnapshotRowDeletePage,
  scanSnapshotArtifactReferencesPage,
  inventorySnapshotArtifactsPage,
  type IcebergSnapshotInventoryCursor,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type IcebergLoadedTable,
  type SnapshotScanCursor,
  type IcebergArtifactReferenceCursor,
  type SnapshotDeleteIntent,
} from '@authrim/ar-lib-logging/iceberg';
import { ensureDatabaseAdapter } from '../db';
import type { DatabaseAdapter } from '../db/adapter';
import {
  assertLogIcebergRemoteConfig,
  type LogIcebergRemoteConfig,
  type LogIcebergConfig,
} from './log-iceberg-config';
import type { LogIcebergPhysicalErasurePort } from './log-iceberg-subject-erasure';
import {
  createLogIcebergCatalog,
  createLogIcebergObjectStore,
  validateLogIcebergTable,
  type LogIcebergCatalogEnv,
} from './log-iceberg-catalog';
import { LOG_ICEBERG_DB_NOW } from './log-iceberg-lease';
import { logIcebergDigest } from './log-iceberg-store';
import { listCapturingTenantBackupTenantKeys } from './tenant-portability/r2-generation-retention';

export interface LogIcebergGcHead {
  size: number;
  etag: string;
  customMetadata?: Record<string, string>;
}
export interface LogIcebergPhysicalErasurePorts {
  admin: DatabaseAdapter;
  catalog: IcebergCatalogPort;
  store: (table: IcebergLoadedTable) => IcebergObjectStore;
  objects: {
    head(path: string): Promise<LogIcebergGcHead | null>;
    delete(path: string): Promise<void>;
    markErased(path: string, etag: string | null): Promise<void>;
    list(prefix: string, cursor?: string): Promise<{ paths: string[]; cursor?: string }>;
  };
  capturingTenantKeys?: () => Promise<Set<string>>;
}
type SubjectInput = Parameters<LogIcebergPhysicalErasurePort['step']>[0];
type Input = Omit<SubjectInput, 'config'> & {
  config: LogIcebergRemoteConfig;
  retention?: { sourceDataset: string; cutoff: number; metadata?: true };
};
export type LogIcebergPhysicalRetentionInput = Omit<SubjectInput, 'erasureId' | 'subjectId'> & {
  retentionId: string;
  sourceDataset: string;
  cutoff: number;
};
function ledger(input: Input) {
  return input.retention
    ? ({
        jobs: 'log_iceberg_retention_jobs',
        artifacts: 'log_iceberg_retention_artifacts',
        ownerColumn: 'retention_id',
      } as const)
    : ({
        jobs: 'log_iceberg_subject_erasures',
        artifacts: 'log_iceberg_erasure_artifacts',
        ownerColumn: 'erasure_id',
      } as const);
}
function scanScope(input: Input) {
  return {
    tenantKey: input.tenantKey,
    sourceDatasets: [input.retention?.sourceDataset ?? 'pii.pii_log'],
    ...(input.retention ? {} : { subjectIds: [input.subjectId] }),
    nowMs: input.retention?.cutoff ?? 0,
  };
}
type Result = Awaited<ReturnType<LogIcebergPhysicalErasurePort['step']>>;
interface Artifact {
  table_uuid: string;
  path_digest: string;
  path: string;
  origin: 'committed' | 'root_uncommitted';
  owner_identity: string | null;
  operation_id: string | null;
  witness_snapshot_id: string | null;
  state: 'found' | 'live_output' | 'removed';
}
interface GcState {
  version: 1;
  tableUuid: string;
  scope: string;
  phase:
    | 'discover'
    | 'owned'
    | 'pins'
    | 'logical'
    | 'rewrite'
    | 'barrier'
    | 'expire'
    | 'references'
    | 'remove'
    | 'complete';
  snapshots: string[];
  discoveredSnapshots?: string[];
  snapshotIndex: number;
  scanCursor?: SnapshotScanCursor;
  inventoryCursor?: IcebergSnapshotInventoryCursor;
  batchAfter?: string;
  batchId?: string;
  prefixIndex?: number;
  listCursor?: string;
  artifactAfter?: string;
  artifactDigests?: string[];
  refSignature?: string;
  refIndex?: number;
  pathIndex?: number;
  refCursor?: IcebergArtifactReferenceCursor;
  fenceOperationId?: string;
  fenceSnapshotId?: string;
  catalogSignature?: string;
  reason?: string;
}
function fence(input: Input): { sql: string; params: string[] } {
  if (!/^[a-f0-9-]{36}$/.test(input.leaseToken)) throw new Error('log_iceberg_gc_fence_invalid');
  return {
    sql: `EXISTS(SELECT 1 FROM scheduled_task_leases WHERE task_id=? AND lease_token=? AND lease_until>${LOG_ICEBERG_DB_NOW})`,
    params: [`log_iceberg:${input.config.tableUuid}`, input.leaseToken],
  };
}
function located(config: LogIcebergConfig, table: IcebergLoadedTable, path: string): void {
  const base = table.metadata.location.replace(/\/$/, '') + '/';
  const url = new URL(path);
  if (
    url.protocol !== 's3:' ||
    url.hostname !== config.bucket ||
    !path.startsWith(base) ||
    path.length > 2048 ||
    /[%?#]/.test(path) ||
    path
      .slice(base.length)
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('log_iceberg_gc_path_invalid');
}
async function signature(table: IcebergLoadedTable): Promise<string> {
  return logIcebergDigest(
    JSON.stringify([
      table.metadataLocation,
      String(table.metadata['current-snapshot-id'] ?? ''),
      table.metadata['last-sequence-number'],
      (table.metadata.snapshots ?? []).map((s) => [
        String(s['snapshot-id']),
        s['sequence-number'],
        s['manifest-list'],
      ]),
      Object.entries(table.metadata.refs ?? {})
        .map(([name, ref]) => [name, String(ref['snapshot-id']), ref.type, ref['max-ref-age-ms']])
        .sort(),
    ])
  );
}
function snapshotIds(table: IcebergLoadedTable): string[] {
  const ids = (table.metadata.snapshots ?? []).map((s) => String(s['snapshot-id']));
  if (
    ids.length > 4096 ||
    new Set(ids).size !== ids.length ||
    Object.values(table.metadata.refs ?? {}).some((r) => !ids.includes(String(r['snapshot-id'])))
  )
    throw new Error('log_iceberg_gc_snapshot_inventory_invalid');
  return ids;
}
function output(state: GcState, complete = false, retiredOperationIds?: string[]): Result {
  const proofJson = JSON.stringify(state);
  if (new TextEncoder().encode(proofJson).byteLength > 128 * 1024)
    throw new Error('log_iceberg_gc_state_budget');
  return { complete, proofJson, ...(retiredOperationIds?.length ? { retiredOperationIds } : {}) };
}
function invalidState(): never {
  throw new Error('log_iceberg_gc_state_invalid');
}
function objectState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidState();
  return value as Record<string, unknown>;
}
function stateNumber(value: unknown, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalidState();
  return value;
}
function stateString(value: unknown, pattern: RegExp, maximum = 256): string {
  if (typeof value !== 'string' || value.length > maximum || !pattern.test(value))
    return invalidState();
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32) return invalidState();
  return value;
}
function stateStrings(value: unknown, maximum: number, pattern: RegExp): string[] {
  if (!Array.isArray(value) || value.length > maximum) return invalidState();
  return value.map((v) => stateString(v, pattern));
}
function gcPhase(value: unknown): GcState['phase'] {
  switch (value) {
    case 'discover':
    case 'owned':
    case 'pins':
    case 'logical':
    case 'rewrite':
    case 'barrier':
    case 'expire':
    case 'references':
    case 'remove':
    case 'complete':
      return value;
    default:
      return invalidState();
  }
}
function scanCursorState(value: unknown, tableUuid: string): SnapshotScanCursor {
  const v = objectState(value),
    position = objectState(v.position);
  if (v.version !== 1 || v.tableUuid !== tableUuid) return invalidState();
  const result: SnapshotScanCursor = {
    version: 1,
    tableUuid,
    snapshotId: stateString(v.snapshotId, /^\d+$/),
    physicalFingerprint: stateString(v.physicalFingerprint, /^[a-f0-9]{64}$/),
    scopeDigest: stateString(v.scopeDigest, /^[a-f0-9]{64}$/),
    position: {
      manifest: stateNumber(position.manifest),
      entry: stateNumber(position.entry),
      row: stateNumber(position.row),
    },
  };
  if (v.columns !== undefined) {
    if (!Array.isArray(v.columns) || v.columns.length > 21) return invalidState();
    result.columns = v.columns.map((c) => {
      const column = objectState(c);
      return {
        fieldId: stateNumber(column.fieldId, 2147483647, 1),
        groupIndex: stateNumber(column.groupIndex),
        byteOffset: stateNumber(column.byteOffset),
        firstRow: stateNumber(column.firstRow),
      };
    });
  }
  return result;
}
function referenceCursorState(value: unknown, tableUuid: string): IcebergArtifactReferenceCursor {
  const v = objectState(value);
  if (v.version !== 1 || v.tableUuid !== tableUuid) return invalidState();
  return {
    version: 1,
    tableUuid,
    snapshotId: stateString(v.snapshotId, /^\d+$/),
    physicalFingerprint: stateString(v.physicalFingerprint, /^[a-f0-9]{64}$/),
    artifactsDigest: stateString(v.artifactsDigest, /^[a-f0-9]{64}$/),
    manifest: stateNumber(v.manifest),
    entry: stateNumber(v.entry),
  };
}
function inventoryCursorState(value: unknown, tableUuid: string): IcebergSnapshotInventoryCursor {
  const v = objectState(value);
  if (v.version !== 1 || v.tableUuid !== tableUuid || typeof v.listed !== 'boolean')
    return invalidState();
  return {
    version: 1,
    tableUuid,
    snapshotId: stateString(v.snapshotId, /^\d+$/),
    physicalFingerprint: stateString(v.physicalFingerprint, /^[a-f0-9]{64}$/),
    manifest: stateNumber(v.manifest),
    entry: stateNumber(v.entry, Number.MAX_SAFE_INTEGER, -1),
    listed: v.listed,
  };
}
function parseState(text: string | undefined, scope: string, table: IcebergLoadedTable): GcState {
  const tableUuid = table.metadata['table-uuid'];
  if (text === undefined)
    return {
      version: 1,
      tableUuid,
      scope,
      phase: 'discover',
      snapshots: snapshotIds(table),
      snapshotIndex: 0,
    };
  if (typeof text !== 'string' || text.length < 1 || text.length > 128 * 1024)
    return invalidState();
  const value: unknown = JSON.parse(text),
    v = objectState(value);
  if (v.version !== 1 || v.scope !== scope || v.tableUuid !== tableUuid) return invalidState();
  const row: GcState = {
    version: 1,
    tableUuid,
    scope,
    phase: gcPhase(v.phase),
    snapshots: stateStrings(v.snapshots, 4096, /^\d+$/),
    snapshotIndex: stateNumber(v.snapshotIndex, 4096),
  };
  if (
    new Set(row.snapshots).size !== row.snapshots.length ||
    row.snapshotIndex > row.snapshots.length
  )
    return invalidState();
  if (v.discoveredSnapshots !== undefined)
    row.discoveredSnapshots = stateStrings(v.discoveredSnapshots, 4096, /^\d+$/);
  if (v.artifactDigests !== undefined)
    row.artifactDigests = stateStrings(v.artifactDigests, 32, /^[a-f0-9]{64}$/);
  if (v.scanCursor !== undefined) row.scanCursor = scanCursorState(v.scanCursor, tableUuid);
  if (v.refCursor !== undefined) row.refCursor = referenceCursorState(v.refCursor, tableUuid);
  if (v.inventoryCursor !== undefined)
    row.inventoryCursor = inventoryCursorState(v.inventoryCursor, tableUuid);
  if (v.prefixIndex !== undefined) row.prefixIndex = stateNumber(v.prefixIndex, 2);
  if (v.refIndex !== undefined) row.refIndex = stateNumber(v.refIndex, 4096);
  if (v.pathIndex !== undefined) row.pathIndex = stateNumber(v.pathIndex, 32);
  if (v.batchAfter !== undefined) row.batchAfter = stateString(v.batchAfter, /^[\s\S]*$/);
  if (v.batchId !== undefined) row.batchId = stateString(v.batchId, /^[\s\S]+$/);
  if (v.listCursor !== undefined) row.listCursor = stateString(v.listCursor, /^[\s\S]+$/, 8192);
  if (v.artifactAfter !== undefined)
    row.artifactAfter = stateString(v.artifactAfter, /^([a-f0-9]{64})?$/);
  if (v.refSignature !== undefined)
    row.refSignature = stateString(v.refSignature, /^[a-f0-9]{64}$/);
  if (v.catalogSignature !== undefined)
    row.catalogSignature = stateString(v.catalogSignature, /^[a-f0-9]{64}$/);
  if (v.fenceOperationId !== undefined)
    row.fenceOperationId = stateString(v.fenceOperationId, /^[a-f0-9]{64}$/);
  if (v.fenceSnapshotId !== undefined)
    row.fenceSnapshotId = stateString(v.fenceSnapshotId, /^\d+$/);
  if (v.reason !== undefined) row.reason = stateString(v.reason, /^[a-z][a-z0-9_]{0,95}$/);
  return row;
}
async function recordArtifact(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  table: IcebergLoadedTable,
  value: {
    path: string;
    origin: Artifact['origin'];
    owner?: string;
    operation?: string;
    witness?: string;
    reopen?: boolean;
  }
): Promise<void> {
  located(input.config, table, value.path);
  const guard = fence(input);
  const digest = await logIcebergDigest(value.path);
  await ports.admin.execute(
    `INSERT INTO ${ledger(input).artifacts}(${ledger(input).ownerColumn},table_uuid,path_digest,path,origin,owner_identity,operation_id,witness_snapshot_id,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,'found',${LOG_ICEBERG_DB_NOW},${LOG_ICEBERG_DB_NOW} WHERE ${guard.sql}
    ON CONFLICT(${ledger(input).ownerColumn},table_uuid,path_digest) DO UPDATE SET path=CASE WHEN ${ledger(input).artifacts}.path=excluded.path THEN excluded.path ELSE NULL END,
      origin=CASE WHEN excluded.origin='committed' THEN 'committed' ELSE ${ledger(input).artifacts}.origin END,
      witness_snapshot_id=COALESCE(${ledger(input).artifacts}.witness_snapshot_id,excluded.witness_snapshot_id),
      owner_identity=COALESCE(${ledger(input).artifacts}.owner_identity,excluded.owner_identity),operation_id=CASE WHEN excluded.origin='committed' AND ${ledger(input).artifacts}.operation_id LIKE 'gc-rewrite:%' THEN NULL ELSE COALESCE(${ledger(input).artifacts}.operation_id,excluded.operation_id) END,state=CASE WHEN excluded.origin='committed' AND ? THEN 'found' ELSE ${ledger(input).artifacts}.state END,updated_at=excluded.updated_at`,
    [
      input.erasureId,
      input.config.tableUuid,
      digest,
      value.path,
      value.origin,
      value.owner ?? null,
      value.operation ?? null,
      value.witness ?? null,
      ...guard.params,
      value.reopen ? 1 : 0,
    ]
  );
}
async function artifacts(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  after = '',
  limit = 32
): Promise<Artifact[]> {
  return ports.admin.query<Artifact>(
    `SELECT * FROM ${ledger(input).artifacts} WHERE ${ledger(input).ownerColumn}=? AND table_uuid=? AND state='found' AND (? OR (origin='root_uncommitted' AND operation_id IN(SELECT value FROM json_each(?)))) AND path_digest>? ORDER BY path_digest LIMIT ?`,
    [
      input.erasureId,
      input.config.tableUuid,
      input.logicalVerified ? 1 : 0,
      JSON.stringify(input.retiredDeleteIntents.map((v) => v.operationId)),
      after,
      limit,
    ],
    { consistencyClass: 'primary_required' }
  );
}
async function currentChunk(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  state: GcState
): Promise<Artifact[]> {
  if (!state.artifactDigests) return artifacts(ports, input, state.artifactAfter);
  const rows = await ports.admin.query<Artifact>(
    `SELECT * FROM ${ledger(input).artifacts} WHERE ${ledger(input).ownerColumn}=? AND table_uuid=? AND (state='found' OR (? AND state='live_output')) AND path_digest IN(SELECT value FROM json_each(?)) ORDER BY path_digest LIMIT 32`,
    [
      input.erasureId,
      input.config.tableUuid,
      state.phase === 'references' ? 1 : 0,
      JSON.stringify(state.artifactDigests),
    ],
    { consistencyClass: 'primary_required' }
  );
  return rows;
}
async function updateRemoved(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  pathDigest: string
): Promise<void> {
  const guard = fence(input);
  await ports.admin.execute(
    `UPDATE ${ledger(input).artifacts} SET state='removed',removed_at=${LOG_ICEBERG_DB_NOW},updated_at=${LOG_ICEBERG_DB_NOW} WHERE ${ledger(input).ownerColumn}=? AND table_uuid=? AND path_digest=? AND ${guard.sql}`,
    [input.erasureId, input.config.tableUuid, pathDigest, ...guard.params]
  );
}
function clearReferences(state: GcState): void {
  state.refIndex = 0;
  state.pathIndex = 0;
  delete state.refCursor;
  delete state.refSignature;
}
async function rootDeletePaths(intent: SnapshotDeleteIntent, location: string): Promise<string[]> {
  const tuples = [
    ...new Set(
      intent.plan.deletes.map((row) =>
        JSON.stringify([
          row.partitionSpecId,
          Object.entries(row.partition).sort(([a], [b]) => a.localeCompare(b)),
        ])
      )
    ),
  ];
  // Native writer group identity uses ordered partition values. Only the two
  // supported specs exist: unpartitioned or a single DAY integer field.
  const values = [
    ...new Map(
      intent.plan.deletes.map((row) => [
        JSON.stringify([
          row.partitionSpecId,
          Object.entries(row.partition).sort(([a], [b]) => a.localeCompare(b)),
        ]),
        row,
      ])
    ).values(),
  ];
  const paths: string[] = [];
  for (let i = 0; i < tuples.length; i++) {
    const row = values[i];
    const key = JSON.stringify([row.partitionSpecId, Object.values(row.partition)]);
    const suffix = (await logIcebergDigest(key)).slice(0, 24);
    paths.push(
      `${location}/data/authrim-${intent.operationId}-${suffix}-deletes.parquet`,
      `${location}/metadata/authrim-${intent.operationId}-delete-m${i}.avro`
    );
  }
  paths.push(
    `${location}/metadata/snap-${intent.snapshotId}-1-authrim-${intent.operationId}-delete.avro`
  );
  return paths;
}
async function markLiveOutput(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  row: Artifact,
  snapshotId: string
): Promise<void> {
  const guard = fence(input);
  await ports.admin.execute(
    `UPDATE ${ledger(input).artifacts} SET state='live_output',origin='committed',witness_snapshot_id=?,updated_at=${LOG_ICEBERG_DB_NOW} WHERE ${ledger(input).ownerColumn}=? AND table_uuid=? AND path_digest=? AND ${guard.sql}`,
    [snapshotId, input.erasureId, input.config.tableUuid, row.path_digest, ...guard.params]
  );
}
async function otherSnapshotHolds(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  table: IcebergLoadedTable
): Promise<string[]> {
  const anchors = await ports.admin.query<{ snapshot_id: string; sequence_number: number | null }>(
    `SELECT DISTINCT json_extract(json_extract(mutation_receipt_json,'$.deleteState'),'$.plan.snapshotId') AS snapshot_id,json_extract(json_extract(mutation_receipt_json,'$.deleteState'),'$.plan.sequenceNumber') AS sequence_number
    FROM (SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_subject_erasures UNION ALL SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_retention_jobs) WHERE id!=? AND state!='completed' AND json_extract(mutation_receipt_json,'$.logicalVerified')=0 AND json_extract(json_extract(mutation_receipt_json,'$.deleteState'),'$.plan.tableUuid')=?
    UNION SELECT DISTINCT json_extract(scan_cursor_json,'$.snapshotId'),NULL FROM (SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_subject_erasures UNION ALL SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_retention_jobs) WHERE id!=? AND state!='completed' AND json_extract(scan_cursor_json,'$.tableUuid')=? LIMIT 4097`,
    [input.erasureId, input.config.tableUuid, input.erasureId, input.config.tableUuid],
    { consistencyClass: 'primary_required' }
  );
  if (anchors.length > 4096) throw new Error('log_iceberg_gc_hold_inventory_budget');
  const held = new Set<string>();
  for (const row of anchors) {
    const snapshot = table.metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === row.snapshot_id
    );
    if (!snapshot) throw new Error('log_iceberg_gc_other_job_anchor_missing');
    for (const id of assertIcebergSnapshotLineage(table.metadata, {
      tableUuid: input.config.tableUuid,
      snapshotId: row.snapshot_id,
      sequenceNumber: row.sequence_number ?? snapshot['sequence-number'] ?? 0,
    }))
      held.add(id);
  }
  const discoveries = await ports.admin.query<{ snapshot_id: string }>(
    `SELECT DISTINCT CAST(h.value AS TEXT) AS snapshot_id FROM (SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_subject_erasures UNION ALL SELECT id,state,scan_cursor_json,mutation_receipt_json FROM log_iceberg_retention_jobs) e,json_each(json_extract(json_extract(e.mutation_receipt_json,'$.gcReceiptJson'),'$.snapshots')) h WHERE e.id!=? AND e.state!='completed' AND json_extract(json_extract(e.mutation_receipt_json,'$.gcReceiptJson'),'$.tableUuid')=? AND json_extract(json_extract(e.mutation_receipt_json,'$.gcReceiptJson'),'$.phase')='discover' LIMIT 4097`,
    [input.erasureId, input.config.tableUuid],
    { consistencyClass: 'primary_required' }
  );
  if (discoveries.length > 4096) throw new Error('log_iceberg_gc_hold_inventory_budget');
  for (const row of discoveries) {
    if (!table.metadata.snapshots?.some((s) => String(s['snapshot-id']) === row.snapshot_id))
      throw new Error('log_iceberg_gc_other_discovery_missing');
    held.add(row.snapshot_id);
  }
  if (held.size > 4096) throw new Error('log_iceberg_gc_hold_inventory_budget');
  return [...held];
}
async function advanceAnchor(
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  table: IcebergLoadedTable
): Promise<{ tableUuid: string; snapshotId: string; sequenceNumber: number }[]> {
  const old = await ports.admin.query<{
    table_uuid: string;
    snapshot_id: string;
    minimum_sequence_number: number;
  }>(
    'SELECT table_uuid,snapshot_id,minimum_sequence_number FROM log_iceberg_read_watermarks WHERE table_uuid=?',
    [input.config.tableUuid],
    { consistencyClass: 'primary_required' }
  );
  for (const row of old)
    assertIcebergSnapshotLineage(table.metadata, {
      tableUuid: row.table_uuid,
      snapshotId: row.snapshot_id,
      sequenceNumber: row.minimum_sequence_number,
    });
  const snapshot = table.metadata.snapshots?.find(
    (s) => String(s['snapshot-id']) === String(table.metadata['current-snapshot-id'])
  );
  if (!snapshot) return [];
  const guard = fence(input);
  const id = String(snapshot['snapshot-id']);
  const sequence = snapshot['sequence-number'] ?? 0;
  await ports.admin.execute(
    `INSERT INTO log_iceberg_read_watermarks(id,table_uuid,minimum_sequence_number,snapshot_id,updated_at) SELECT ?,?,?,?,${LOG_ICEBERG_DB_NOW} WHERE ${guard.sql}
    ON CONFLICT(id) DO UPDATE SET minimum_sequence_number=excluded.minimum_sequence_number,snapshot_id=excluded.snapshot_id,updated_at=excluded.updated_at WHERE log_iceberg_read_watermarks.minimum_sequence_number<=excluded.minimum_sequence_number`,
    [input.config.tableUuid, input.config.tableUuid, sequence, id, ...guard.params]
  );
  return [{ tableUuid: input.config.tableUuid, snapshotId: id, sequenceNumber: sequence }];
}

/** One bounded proof step under the caller's Control permit and table fence. */
async function runPhysicalArchiveRemovalStep(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts,
  input: Input,
  assertFence: () => Promise<void>
): Promise<Result> {
  if (
    input.config.tableUuid !== config.tableUuid ||
    input.config.physicalFingerprint !== config.physicalFingerprint ||
    !/^[a-f0-9]{64}$/.test(input.erasureId) ||
    input.retiredDeleteIntents.length > 8
  )
    throw new Error('log_iceberg_gc_scope_invalid');
  await assertFence();
  let table = await ports.catalog.loadTable();
  await validateLogIcebergTable(config, table);
  const owner = await ports.admin.queryOne<{
    tenant_key: string;
    subject_id: string;
    source_dataset: string;
    cutoff?: number;
  }>(
    input.retention
      ? `SELECT tenant_key,'' AS subject_id,source_dataset,cutoff FROM log_iceberg_retention_jobs WHERE id=? AND table_uuid=?`
      : 'SELECT tenant_key,subject_id,source_dataset FROM log_iceberg_subject_erasures WHERE id=?',
    input.retention ? [input.erasureId, config.tableUuid] : [input.erasureId],
    { consistencyClass: 'primary_required' }
  );
  if (
    !owner ||
    owner.tenant_key !== input.tenantKey ||
    owner.subject_id !== input.subjectId ||
    owner.source_dataset !== (input.retention?.sourceDataset ?? 'pii.pii_log') ||
    (input.retention && owner.cutoff !== input.retention.cutoff)
  )
    throw new Error('log_iceberg_gc_scope_invalid');
  const scope = await logIcebergDigest(
    JSON.stringify([
      input.erasureId,
      config.tableUuid,
      config.physicalFingerprint,
      input.tenantKey,
      input.subjectId,
      input.logicalVerified,
      input.retention ?? null,
    ])
  );
  const state = parseState(input.receiptJson, scope, table);
  if (!input.receiptJson && !input.logicalVerified) state.snapshots = [];
  const capturing = await (ports.capturingTenantKeys
    ? ports.capturingTenantKeys()
    : listCapturingTenantBackupTenantKeys(ports.admin));
  if (capturing.has(input.tenantKey) || (input.retention?.metadata && capturing.size > 0)) {
    state.reason = 'backup_capturing';
    return output(state);
  }
  delete state.reason;
  if (state.phase === 'complete') {
    if (state.catalogSignature === (await signature(table)))
      return output(state, input.logicalVerified);
    state.phase = 'discover';
    state.snapshots = snapshotIds(table);
    state.snapshotIndex = 0;
    delete state.scanCursor;
  }
  if (state.phase === 'discover') {
    if (state.snapshotIndex < state.snapshots.length) {
      const id = state.snapshots[state.snapshotIndex];
      if (!table.metadata.snapshots?.some((s) => String(s['snapshot-id']) === id))
        throw new Error('log_iceberg_gc_discovery_snapshot_expired');
      if (input.retention?.metadata) {
        const page = await inventorySnapshotArtifactsPage({
          table,
          store: ports.store(table),
          snapshotId: id,
          cursor: state.inventoryCursor,
        });
        for (const path of page.artifacts)
          await recordArtifact(ports, input, table, {
            path,
            origin: 'committed',
            witness: id,
            reopen: true,
          });
        if (page.complete) {
          if (!(state.discoveredSnapshots ??= []).includes(id)) state.discoveredSnapshots.push(id);
          state.snapshotIndex++;
          delete state.inventoryCursor;
        } else state.inventoryCursor = page.nextCursor;
        await assertFence();
        return output(state);
      }
      const page = await (
        input.retention ? scanSnapshotExpiredFilesPage : scanSnapshotSubjectFilesPage
      )({
        table,
        store: ports.store(table),
        snapshotId: id,
        ...scanScope(input),
        pageSize: 32,
        cursor: state.scanCursor,
      });
      for (const row of page.deletes)
        await recordArtifact(ports, input, table, {
          path: row.filePath,
          origin: 'committed',
          witness: id,
          reopen: true,
        });
      if (page.complete) {
        if (!(state.discoveredSnapshots ??= []).includes(id)) state.discoveredSnapshots.push(id);
        if (state.discoveredSnapshots.length > 4096)
          throw new Error('log_iceberg_gc_snapshot_inventory_invalid');
        state.snapshotIndex++;
        delete state.scanCursor;
      } else state.scanCursor = page.nextCursor;
      await assertFence();
      return output(state);
    }
    if (input.logicalVerified && input.deleteIntent)
      for (const row of input.deleteIntent.plan.deletes)
        await recordArtifact(ports, input, table, {
          path: row.filePath,
          origin: 'committed',
          witness: input.deleteIntent.plan.snapshotId ?? undefined,
        });
    for (const intent of input.retiredDeleteIntents) {
      if (
        intent.plan.tableUuid !== config.tableUuid ||
        intent.plan.physicalFingerprint !== config.physicalFingerprint
      )
        throw new Error('log_iceberg_gc_retirement_scope_invalid');
      for (const path of await rootDeletePaths(intent, table.metadata.location))
        await recordArtifact(ports, input, table, {
          path,
          origin: 'root_uncommitted',
          owner: `position-delete:${intent.operationId}:${intent.plan.physicalFingerprint}`,
          operation: intent.operationId,
        });
    }
    if (!input.logicalVerified) {
      state.phase = 'pins';
      state.artifactAfter = '';
      delete state.artifactDigests;
      clearReferences(state);
      return output(state);
    }
    state.phase = 'owned';
    return output(state);
  }
  if (state.phase === 'owned') {
    const batch = await ports.admin.queryOne<{ id: string; checkpoint_json: string | null }>(
      `SELECT id,checkpoint_json FROM log_iceberg_export_batches WHERE tenant_key=? AND source_dataset=? AND last_error_code=? AND id>? ORDER BY id LIMIT 1`,
      [
        input.tenantKey,
        input.retention?.sourceDataset ?? 'pii.pii_log',
        (input.retention ? 'log_iceberg_retention_' : 'log_iceberg_erasure_') + input.erasureId,
        state.batchAfter ?? '',
      ],
      { consistencyClass: 'primary_required' }
    );
    if (batch?.checkpoint_json) {
      const checkpoint: unknown = JSON.parse(batch.checkpoint_json);
      if (
        !checkpoint ||
        typeof checkpoint !== 'object' ||
        !('tableUuid' in checkpoint) ||
        checkpoint.tableUuid !== config.tableUuid ||
        !('batchDigest' in checkpoint) ||
        typeof checkpoint.batchDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(checkpoint.batchDigest) ||
        !('snapshotId' in checkpoint) ||
        !/^\d+$/.test(String(checkpoint.snapshotId))
      )
        throw new Error('log_iceberg_gc_append_checkpoint_invalid');
      if (
        !('batchId' in checkpoint) ||
        checkpoint.batchId !== batch.id ||
        !('storageGeneration' in checkpoint) ||
        checkpoint.storageGeneration !== config.generation ||
        !('physicalFingerprint' in checkpoint) ||
        checkpoint.physicalFingerprint !== config.physicalFingerprint ||
        !('tenantKey' in checkpoint) ||
        checkpoint.tenantKey !== input.tenantKey ||
        !('sourceDataset' in checkpoint) ||
        checkpoint.sourceDataset !== (input.retention?.sourceDataset ?? 'pii.pii_log')
      )
        throw new Error('log_iceberg_gc_append_checkpoint_invalid');
      const artifactId = await logIcebergDigest(batch.id);
      // A suspended PUT can finish after a prefix listing. Scheduled tables are
      // strictly unpartitioned, so reserve the exact known body path even while
      // absent and place an immutable-PUT denial before declaring completion.
      if (config.mode === 'scheduled')
        for (const path of [
          `${table.metadata.location}/data/authrim-${artifactId}-${await logIcebergDigest('{}')}.parquet`,
          `${table.metadata.location}/metadata/authrim-${artifactId}-m0.avro`,
        ])
          await recordArtifact(ports, input, table, {
            path,
            origin: 'root_uncommitted',
            owner: `${config.tableUuid}:${checkpoint.batchDigest}`,
            operation: 'append:' + batch.id,
          });
      const prefixes = [
        `${table.metadata.location}/data/authrim-${artifactId}-`,
        `${table.metadata.location}/metadata/authrim-${artifactId}`,
        `${table.metadata.location}/metadata/snap-${String(checkpoint.snapshotId)}-1-${artifactId}`,
      ];
      const index = state.batchId === batch.id ? (state.prefixIndex ?? 0) : 0;
      const page = await ports.objects.list(
        prefixes[index],
        state.batchId === batch.id ? state.listCursor : undefined
      );
      if (page.paths.length > 32) throw new Error('log_iceberg_gc_listing_budget');
      for (const path of page.paths)
        await recordArtifact(ports, input, table, {
          path,
          origin: 'root_uncommitted',
          owner: `${config.tableUuid}:${checkpoint.batchDigest}`,
          operation: 'append:' + batch.id,
        });
      state.batchId = batch.id;
      state.prefixIndex = index;
      state.listCursor = page.cursor;
      if (!page.cursor) {
        delete state.listCursor;
        if (index + 1 < prefixes.length) state.prefixIndex = index + 1;
        else {
          state.batchAfter = batch.id;
          delete state.batchId;
          delete state.prefixIndex;
        }
      }
      await assertFence();
      return output(state);
    }
    if (batch) {
      state.batchAfter = batch.id;
      return output(state);
    }
    state.phase = 'pins';
    state.artifactAfter = '';
    delete state.artifactDigests;
    clearReferences(state);
    return output(state);
  }
  let chunk = await currentChunk(ports, input, state);
  if (!chunk.length) {
    if (state.artifactDigests) {
      state.artifactAfter = state.artifactDigests.at(-1) ?? state.artifactAfter;
      delete state.artifactDigests;
      state.phase = 'pins';
      clearReferences(state);
      return output(state);
    }
    if ((await artifacts(ports, input, '', 1)).length) {
      state.artifactAfter = '';
      state.phase = 'pins';
      clearReferences(state);
      return output(state);
    }
    const unseen = (input.logicalVerified ? snapshotIds(table) : []).filter(
      (id) => !(state.discoveredSnapshots ?? []).includes(id)
    );
    if (unseen.length) {
      state.phase = 'discover';
      state.snapshots = unseen;
      state.snapshotIndex = 0;
      delete state.scanCursor;
      return output(state);
    }
    const retired: string[] = [];
    for (const intent of input.retiredDeleteIntents) {
      const pending = await ports.admin.queryOne(
        `SELECT 1 FROM ${ledger(input).artifacts} WHERE ${ledger(input).ownerColumn}=? AND table_uuid=? AND operation_id=? AND state!='removed' LIMIT 1`,
        [input.erasureId, config.tableUuid, intent.operationId],
        { consistencyClass: 'primary_required' }
      );
      if (!pending) retired.push(intent.operationId);
    }
    state.phase = 'complete';
    state.catalogSignature = await signature(table);
    return output(state, input.logicalVerified, retired);
  }
  if (!state.artifactDigests) state.artifactDigests = chunk.map((r) => r.path_digest);
  chunk.forEach((r) => {
    located(config, table, r.path);
  });
  const lifecycle = () =>
    new IcebergLifecycle({
      catalog: ports.catalog,
      store: ports.store(table),
      tableLocation: table.metadata.location,
    });
  if (state.phase === 'pins') {
    const refs = Object.entries(table.metadata.refs ?? {}).filter(
      ([name, ref]) =>
        name !== 'main' &&
        (() => {
          const s = table.metadata.snapshots?.find(
            (v) => String(v['snapshot-id']) === String(ref['snapshot-id'])
          );
          if (!s) throw new Error('log_iceberg_gc_ref_missing');
          return (
            ref['max-ref-age-ms'] === undefined ||
            s['timestamp-ms'] + ref['max-ref-age-ms'] > Date.now()
          );
        })()
    );
    const sig = await logIcebergDigest(
      JSON.stringify(refs.map(([name, ref]) => [name, String(ref['snapshot-id'])]))
    );
    if (state.refSignature !== sig) {
      clearReferences(state);
      state.refSignature = sig;
    }
    if ((state.refIndex ?? 0) < refs.length) {
      const ref = refs[state.refIndex ?? 0][1];
      const index = state.pathIndex ?? 0;
      if (index >= chunk.length) {
        state.refIndex = (state.refIndex ?? 0) + 1;
        state.pathIndex = 0;
        delete state.refCursor;
        return output(state);
      }
      const row = chunk[index];
      const page = await scanSnapshotArtifactReferencesPage({
        table,
        store: ports.store(table),
        snapshotId: String(ref['snapshot-id']),
        artifacts: [row.path],
        cursor: state.refCursor,
      });
      if (page.referenced) {
        if (input.retention?.metadata || row.operation_id?.startsWith('gc-rewrite:')) {
          await markLiveOutput(ports, input, row, String(ref['snapshot-id']));
          delete state.refCursor;
          return output(state);
        }
        state.reason = 'live_snapshot_pin';
        return output(state);
      }
      if (page.complete) {
        state.pathIndex = index + 1;
        delete state.refCursor;
      } else state.refCursor = page.nextCursor;
      return output(state);
    }
    state.phase = input.logicalVerified && !input.retention?.metadata ? 'logical' : 'barrier';
    state.refIndex = 0;
    delete state.refCursor;
    state.fenceOperationId = await logIcebergDigest(JSON.stringify([scope, crypto.randomUUID()]));
    return output(state);
  }
  if (state.phase === 'logical') {
    const current = String(table.metadata['current-snapshot-id'] ?? '');
    if (state.scanCursor && state.scanCursor.snapshotId !== current) delete state.scanCursor;
    const page = await planSnapshotRowDeletePage(
      {
        table,
        store: ports.store(table),
        ...scanScope(input),
        pageSize: 32,
        cursor: state.scanCursor,
      },
      input.retention ? 'expired' : 'subject'
    );
    if (page.deletes.length) {
      for (const row of page.deletes)
        await recordArtifact(ports, input, table, {
          path: row.filePath,
          origin: 'committed',
          witness: page.snapshotId ?? undefined,
          reopen: true,
        });
      state.reason = 'logical_rescan_required';
      return { ...output(state), needsLogicalRescan: true };
    }
    if (!page.complete) {
      state.scanCursor = page.nextCursor;
      return output(state);
    }
    delete state.scanCursor;
    state.phase = 'rewrite';
    state.refIndex = 0;
    return output(state);
  }
  if (state.phase === 'rewrite') {
    const index = state.refIndex ?? 0;
    if (index < chunk.length) {
      const row = chunk[index];
      const current = table.metadata['current-snapshot-id'];
      if (current !== undefined) {
        const page = await scanSnapshotArtifactReferencesPage({
          table,
          store: ports.store(table),
          snapshotId: String(current),
          artifacts: [row.path],
          cursor: state.refCursor,
        });
        if (!page.complete && !page.referenced) {
          state.refCursor = page.nextCursor;
          return output(state);
        }
        delete state.refCursor;
        if (page.referenced) {
          if (input.retention?.metadata || row.operation_id?.startsWith('gc-rewrite:')) {
            await markLiveOutput(ports, input, row, String(current));
            return output(state);
          }
          const head = await ports.objects.head(row.path);
          if (!head) throw new Error('log_iceberg_gc_live_file_missing');
          if (head.size > 8 * 1024 * 1024) {
            state.reason = 'provider_compaction_pending';
            return output(state);
          }
          await assertFence();
          const operation = 'gc-rewrite:' + crypto.randomUUID();
          const base = ports.store(table);
          const tracked: IcebergObjectStore = {
            read: base.read.bind(base),
            ...(base.size ? { size: base.size.bind(base) } : {}),
            ...(base.readRange ? { readRange: base.readRange.bind(base) } : {}),
            putImmutable: async (path, bytes, identity) => {
              await recordArtifact(ports, input, table, {
                path,
                origin: 'root_uncommitted',
                owner: identity,
                operation,
              });
              await assertFence();
              await base.putImmutable(path, bytes, identity);
            },
          };
          try {
            await assertLogArchiveRewriteBudget({ table, store: base, path: row.path });
            await new IcebergLifecycle({
              catalog: ports.catalog,
              store: tracked,
              tableLocation: table.metadata.location,
            }).rewriteFiles([row.path]);
          } catch (error) {
            if (error instanceof IcebergCatalogConflictError) {
              state.phase = 'pins';
              delete state.artifactDigests;
              state.artifactAfter = '';
              clearReferences(state);
              return output(state);
            }
            if (error instanceof IcebergBudgetError) {
              state.reason = 'provider_compaction_pending';
              return output(state);
            }
            throw error;
          }
          await assertFence();
        }
      }
      state.refIndex = index + 1;
      return output(state);
    }
    state.phase = 'barrier';
    state.fenceOperationId = await logIcebergDigest(JSON.stringify([scope, crypto.randomUUID()]));
    clearReferences(state);
    return output(state);
  }
  if (state.phase === 'barrier') {
    const advanced = await advanceIcebergMainForGc({
      catalog: ports.catalog,
      store: ports.store(table),
      operationId: state.fenceOperationId ?? (await logIcebergDigest(crypto.randomUUID())),
      assertFence,
    });
    state.fenceSnapshotId = advanced.snapshotId;
    if (
      input.retention?.metadata &&
      !(state.discoveredSnapshots ??= []).includes(advanced.snapshotId)
    )
      state.discoveredSnapshots.push(advanced.snapshotId);
    state.phase = input.logicalVerified ? 'expire' : 'references';
    if (!input.logicalVerified) {
      state.snapshots = snapshotIds(advanced.table);
      state.snapshotIndex = 0;
      state.catalogSignature = await signature(advanced.table);
    }
    clearReferences(state);
    return output(state);
  }
  if (state.phase === 'expire') {
    const anchors = await advanceAnchor(ports, input, table);
    await assertFence();
    await lifecycle().expireSnapshots(
      Date.now() + 1,
      anchors,
      128,
      await otherSnapshotHolds(ports, input, table)
    );
    await assertFence();
    table = await ports.catalog.loadTable();
    await validateLogIcebergTable(config, table);
    state.phase = 'references';
    state.snapshots = snapshotIds(table);
    state.snapshotIndex = 0;
    state.pathIndex = 0;
    state.catalogSignature = await signature(table);
    delete state.refCursor;
    return output(state);
  }
  if (state.phase === 'references') {
    const currentSig = await signature(table);
    if (state.catalogSignature !== currentSig) {
      // Snapshots are immutable. Keep completed certificates and only append
      // new IDs, so normal Pipeline appends do not starve a bounded GC scan.
      const added = snapshotIds(table).filter((id) => !state.snapshots.includes(id));
      if (state.snapshots.length + added.length > 4096)
        throw new Error('log_iceberg_gc_snapshot_inventory_invalid');
      state.snapshots.push(...added);
      state.catalogSignature = currentSig;
    }
    if (state.snapshotIndex < state.snapshots.length) {
      const snapshotId = state.snapshots[state.snapshotIndex];
      if (!table.metadata.snapshots?.some((s) => String(s['snapshot-id']) === snapshotId)) {
        state.snapshotIndex++;
        delete state.refCursor;
        return output(state);
      }
      const page = await scanSnapshotArtifactReferencesPage({
        table,
        store: ports.store(table),
        snapshotId,
        artifacts: chunk.map((r) => r.path),
        includeReferencedArtifacts: true,
        cursor: state.refCursor,
      });
      for (const path of page.referencedArtifacts ?? []) {
        const row = chunk.find((r) => r.path === path);
        if (!row) throw new Error('log_iceberg_gc_reference_scope_invalid');
        if (input.retention?.metadata || row.operation_id?.startsWith('gc-rewrite:'))
          await markLiveOutput(ports, input, row, snapshotId);
        else {
          state.phase = 'pins';
          state.reason = 'retained_snapshot_reference';
          clearReferences(state);
          return output(state);
        }
      }
      if (page.complete) {
        state.snapshotIndex++;
        delete state.refCursor;
      } else state.refCursor = page.nextCursor;
      return output(state);
    }
    state.phase = 'remove';
    return output(state);
  }
  if (state.phase === 'remove') {
    if (state.catalogSignature !== (await signature(table))) {
      state.phase = 'references';
      delete state.refCursor;
      return output(state);
    }
    for (const row of chunk.slice(0, 4)) {
      await assertFence();
      const fresh = await ports.catalog.loadTable();
      await validateLogIcebergTable(config, fresh);
      if ((await signature(fresh)) !== state.catalogSignature) {
        state.phase = 'references';
        delete state.refCursor;
        return output(state);
      }
      const head = await ports.objects.head(row.path);
      if (head) {
        const marker =
          head.size === 0 &&
          head.customMetadata?.authrim_iceberg_gc_erased === '1' &&
          head.customMetadata?.authrim_artifact_digest === row.path_digest &&
          Object.keys(head.customMetadata ?? {}).length === 2;
        if (!marker) {
          if (
            row.origin === 'root_uncommitted' &&
            head.customMetadata?.authrim_identity !== row.owner_identity
          )
            throw new Error('log_iceberg_gc_artifact_owner_changed');
          await assertFence();
          if (
            row.origin === 'root_uncommitted' ||
            (row.path.includes('/data/authrim-') &&
              new RegExp('^' + config.tableUuid + ':[a-f0-9]{64}$').test(
                head.customMetadata?.authrim_identity ?? ''
              ))
          )
            await ports.objects.markErased(row.path, head.etag);
          else await ports.objects.delete(row.path);
          const after = await ports.objects.head(row.path);
          if (
            after &&
            !(
              after.size === 0 &&
              after.customMetadata?.authrim_iceberg_gc_erased === '1' &&
              after.customMetadata?.authrim_artifact_digest === row.path_digest &&
              Object.keys(after.customMetadata ?? {}).length === 2
            )
          ) {
            state.reason = 'artifact_delete_not_confirmed';
            return output(state);
          }
        }
      } else if (row.origin === 'root_uncommitted') {
        await ports.objects.markErased(row.path, null);
        const after = await ports.objects.head(row.path);
        if (
          !after ||
          after.size !== 0 ||
          after.customMetadata?.authrim_artifact_digest !== row.path_digest
        ) {
          state.reason = 'orphan_marker_not_confirmed';
          return output(state);
        }
      }
      await updateRemoved(ports, input, row.path_digest);
      await assertFence();
    }
    chunk = await currentChunk(ports, input, state);
    if (!chunk.length) {
      const last = state.artifactDigests?.at(-1);
      state.artifactAfter = last ?? state.artifactAfter;
      delete state.artifactDigests;
      state.phase = 'pins';
      clearReferences(state);
    }
    return output(state);
  }
  throw new Error('log_iceberg_gc_phase_invalid');
}

export function runLogIcebergPhysicalErasureStep(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts,
  input: SubjectInput,
  assertFence: () => Promise<void>
): Promise<Result> {
  assertLogIcebergRemoteConfig(config);
  assertLogIcebergRemoteConfig(input.config);
  return runPhysicalArchiveRemovalStep(
    config,
    ports,
    { ...input, config: input.config, retention: undefined },
    assertFence
  );
}
export function runLogIcebergPhysicalRetentionStep(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts,
  input: LogIcebergPhysicalRetentionInput,
  assertFence: () => Promise<void>
): Promise<Result> {
  assertLogIcebergRemoteConfig(config);
  assertLogIcebergRemoteConfig(input.config);
  if (
    input.sourceDataset.length > 256 ||
    !/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*$/.test(input.sourceDataset) ||
    !Number.isSafeInteger(input.cutoff) ||
    input.cutoff < 0
  )
    throw new Error('log_iceberg_gc_retention_scope_invalid');
  return runPhysicalArchiveRemovalStep(
    config,
    ports,
    {
      ...input,
      config: input.config,
      erasureId: input.retentionId,
      subjectId: '',
      retention: { sourceDataset: input.sourceDataset, cutoff: input.cutoff },
    },
    assertFence
  );
}
/** Exact committed metadata inventory precedes expiration, even with no expired rows. */
export function runLogIcebergPhysicalMetadataStep(
  config: LogIcebergConfig,
  ports: LogIcebergPhysicalErasurePorts,
  input: { leaseToken: string; retentionId: string; cutoff: number; receiptJson?: string },
  assertFence: () => Promise<void>
): Promise<Result> {
  assertLogIcebergRemoteConfig(config);
  if (!Number.isSafeInteger(input.cutoff) || input.cutoff < 0)
    throw new Error('log_iceberg_gc_metadata_scope_invalid');
  return runPhysicalArchiveRemovalStep(
    config,
    ports,
    {
      config,
      leaseToken: input.leaseToken,
      erasureId: input.retentionId,
      tenantKey: '__environment__',
      subjectId: '',
      deleteIntent: null,
      logicalVerified: true,
      retiredDeleteIntents: [],
      receiptJson: input.receiptJson,
      retention: { sourceDataset: 'system.snapshot_gc', cutoff: input.cutoff, metadata: true },
    },
    assertFence
  );
}

export function createLogIcebergPhysicalErasurePort(
  env: LogIcebergCatalogEnv,
  config: LogIcebergConfig
): LogIcebergPhysicalErasurePort {
  const ports = createLogIcebergPhysicalRemovalPorts(env, config);
  return {
    step: (input, assertFence) =>
      runLogIcebergPhysicalErasureStep(config, ports, input, assertFence),
  };
}
export function createLogIcebergPhysicalRetentionPort(
  env: LogIcebergCatalogEnv,
  config: LogIcebergConfig
) {
  const ports = createLogIcebergPhysicalRemovalPorts(env, config);
  return {
    step: (input: LogIcebergPhysicalRetentionInput, assertFence: () => Promise<void>) =>
      runLogIcebergPhysicalRetentionStep(config, ports, input, assertFence),
  };
}

export function createLogIcebergPhysicalRemovalPorts(
  env: LogIcebergCatalogEnv,
  config: LogIcebergConfig
): LogIcebergPhysicalErasurePorts {
  assertLogIcebergRemoteConfig(config);
  if (!env.DB_ADMIN || !env.LOG_ARCHIVE) throw new Error('log_iceberg_gc_storage_unavailable');
  const admin = ensureDatabaseAdapter(env.DB_ADMIN, 'log-iceberg-gc');
  const bucket = env.LOG_ARCHIVE;
  const catalog = createLogIcebergCatalog(env, config, 'write');
  let known: IcebergLoadedTable | undefined;
  const table = async () => (known ??= await catalog.loadTable());
  const key = async (path: string) => {
    const loaded = await table();
    await validateLogIcebergTable(config, loaded);
    located(config, loaded, path);
    return createLogIcebergObjectStore(env, loaded).objectKey(path);
  };
  return {
    admin,
    catalog,
    store: (loaded) => createLogIcebergObjectStore(env, loaded),
    objects: {
      head: async (path) => bucket.head(await key(path)),
      delete: async (path) => bucket.delete(await key(path)),
      markErased: async (path, etag) => {
        await bucket.put(await key(path), new Uint8Array(0), {
          onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
          customMetadata: {
            authrim_iceberg_gc_erased: '1',
            authrim_artifact_digest: await logIcebergDigest(path),
          },
        });
      },
      list: async (prefix, cursor) => {
        const page = await bucket.list({ prefix: await key(prefix), cursor, limit: 32 });
        const loaded = await table();
        const base = new URL(loaded.metadata.location);
        return {
          paths: page.objects.map((o) => `s3://${base.hostname}/${o.key}`),
          ...(page.truncated ? { cursor: page.cursor } : {}),
        };
      },
    },
  };
}
