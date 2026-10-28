import { findSnapshotFile, type ManifestScanPosition } from './manifest-scan.js';
import { splitManifestEntries } from 'icebird/src/manifest.js';
import { fetchDeleteMaps } from 'icebird/src/fetch.js';
import { applicablePositionDeletes, deleteFileAppliesToDataEntry } from 'icebird/src/delete.js';
import { equalityMatch } from 'icebird/src/utils.js';
import { readFlatFileWindow, type FlatColumnCursor } from './flat-reader.js';
import { safeReadResolver, type ArchiveParquetFilter } from './read-buffer.js';
import { inspectLogArchiveTable, logArchivePhysicalFingerprint } from './physical-schema.js';
import { assertLogArchiveTable } from './catalog.js';
import { assertLogArchiveRecord, LOG_ARCHIVE_FIELDS, type LogArchiveRecord } from './schema.js';
import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from './types.js';

export interface IcebergReadWatermark {
  tableUuid: string;
  minimumSequenceNumber: number;
}
export interface SnapshotReadOptions {
  table: IcebergLoadedTable;
  store: IcebergObjectStore;
  snapshotId?: string;
  tenantKey: string;
  sourceDatasets: readonly string[];
  nowMs: number;
  eventIds?: readonly string[];
  subjectIds?: readonly string[];
  eventAtFrom?: number;
  providerIngestedAtFrom?: number;
  providerIngestedAtTo?: number;
  eventAtTo?: number;
  watermark?: IcebergReadWatermark;
  limits?: Partial<{
    maxRows: number;
    maxFiles: number;
    maxBytes: number;
    maxFileBytes: number;
    deadlineMs: number;
  }>;
}
export interface SnapshotReadResult {
  tableUuid: string;
  snapshotId: string | null;
  sequenceNumber: number;
  records: LogArchiveRecord[];
}
const READ_LIMITS = {
  maxRows: 10_000,
  maxFiles: 128,
  maxBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  deadlineMs: 10_000,
};

function rowFromParquet(value: unknown): LogArchiveRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid archive Parquet row');
  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const field of LOG_ARCHIVE_FIELDS) {
    const item = record[field.name];
    if (field.type === 'long' && typeof item === 'bigint') {
      const number = Number(item);
      if (!Number.isSafeInteger(number) || BigInt(number) !== item)
        throw new Error('Archive timestamp exceeds safe milliseconds');
      normalized[field.name] = number;
    } else {
      normalized[field.name] = item;
    }
  }
  assertLogArchiveRecord(normalized);
  return normalized;
}
function manifestMayMatch(
  entry: ReturnType<typeof splitManifestEntries>['dataEntries'][number],
  options: SnapshotReadOptions,
  includeExpired: boolean,
  fieldIds: ReturnType<typeof inspectLogArchiveTable>['fieldIds']
): boolean {
  const data = entry.data_file;
  const mapValue = (map: unknown, id: number): unknown => {
    if (Array.isArray(map)) {
      const entry: unknown = map.find(
        (item: unknown) =>
          typeof item === 'object' && item !== null && 'key' in item && Number(item.key) === id
      );
      return typeof entry === 'object' && entry !== null && 'value' in entry
        ? entry.value
        : undefined;
    }
    return typeof map === 'object' && map !== null
      ? (map as Record<string, unknown>)[String(id)]
      : undefined;
  };
  const bound = (kind: 'lower_bounds' | 'upper_bounds', id: number): Uint8Array | undefined => {
    const value = mapValue(data[kind], id);
    return value instanceof Uint8Array ? value : undefined;
  };
  const compare = (a: Uint8Array, b: Uint8Array): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  const stringMayEqual = (id: number, value: string): boolean => {
    const encoded = new TextEncoder().encode(value);
    const lower = bound('lower_bounds', id);
    const upper = bound('upper_bounds', id);
    return (!lower || compare(encoded, lower) >= 0) && (!upper || compare(encoded, upper) <= 0);
  };
  if (
    !stringMayEqual(fieldIds.tenant_key, options.tenantKey) ||
    !options.sourceDatasets.some((dataset) => stringMayEqual(fieldIds.source_dataset, dataset))
  )
    return false;
  const number = (kind: 'lower_bounds' | 'upper_bounds', id: number): bigint | undefined => {
    const value = bound(kind, id);
    return value?.byteLength === 8
      ? new DataView(value.buffer, value.byteOffset, 8).getBigInt64(0, true)
      : undefined;
  };
  const lower = number('lower_bounds', fieldIds.event_at);
  const upper = number('upper_bounds', fieldIds.event_at);
  if (
    options.eventAtFrom !== undefined &&
    upper !== undefined &&
    upper < BigInt(options.eventAtFrom)
  )
    return false;
  if (options.eventAtTo !== undefined && lower !== undefined && lower >= BigInt(options.eventAtTo))
    return false;
  if (options.eventIds && !options.eventIds.some((id) => stringMayEqual(fieldIds.event_id, id)))
    return false;
  if (
    options.subjectIds &&
    !options.subjectIds.some((id) => stringMayEqual(fieldIds.subject_id, id))
  )
    return false;
  const expires = number('upper_bounds', fieldIds.expires_at);
  if (
    !includeExpired &&
    expires !== undefined &&
    expires <= BigInt(options.nowMs) &&
    mapValue(data.null_value_counts, fieldIds.expires_at) === 0n
  )
    return false;
  return true;
}

function sameLogicalContent(a: LogArchiveRecord, b: LogArchiveRecord): boolean {
  return LOG_ARCHIVE_FIELDS.every(
    ({ name }) =>
      ['detail_ciphertext', 'detail_key_version', 'storage_generation', 'ingested_at'].includes(
        name
      ) || a[name] === b[name]
  );
}

export interface SnapshotScanCursor {
  version: 1;
  tableUuid: string;
  snapshotId: string;
  physicalFingerprint: string;
  scopeDigest: string;
  position: ManifestScanPosition;
  columns?: readonly FlatColumnCursor[];
}
export interface SnapshotPageOptions extends SnapshotReadOptions {
  pageSize?: number;
  cursor?: SnapshotScanCursor;
}
export interface SnapshotPageResult extends SnapshotReadResult {
  complete: boolean;
  nextCursor?: SnapshotScanCursor;
}

function validateRead(options: SnapshotReadOptions) {
  assertLogArchiveTable(options.table.metadata);
  if (
    !options.tenantKey ||
    options.tenantKey.length > 256 ||
    !options.sourceDatasets.length ||
    options.sourceDatasets.length > 64 ||
    options.sourceDatasets.some((dataset) => !dataset || dataset.length > 256) ||
    !Number.isSafeInteger(options.nowMs) ||
    [
      options.eventAtFrom,
      options.eventAtTo,
      options.providerIngestedAtFrom,
      options.providerIngestedAtTo,
    ].some((value) => value !== undefined && !Number.isSafeInteger(value)) ||
    (options.eventIds !== undefined &&
      (options.eventIds.length < 1 ||
        options.eventIds.length > 100 ||
        options.eventIds.some((id) => !id || id.length > 256))) ||
    (options.subjectIds !== undefined &&
      (options.subjectIds.length < 1 ||
        options.subjectIds.length > 100 ||
        options.subjectIds.some((id) => !id || id.length > 256)))
  )
    throw new Error('Invalid archive read scope');
  const limits = { ...READ_LIMITS, ...options.limits };
  for (const key of Object.keys(READ_LIMITS) as (keyof typeof READ_LIMITS)[])
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > READ_LIMITS[key])
      throw new Error('Invalid archive read budget');
  return limits;
}
function snapshotIdentity(options: SnapshotReadOptions, cursor?: SnapshotScanCursor) {
  const metadata = options.table.metadata;
  const current = metadata['current-snapshot-id'];
  const id =
    cursor?.snapshotId ??
    options.snapshotId ??
    (current == null || BigInt(current) < 0n ? null : String(current));
  if (id !== null && !/^\d+$/.test(id)) throw new Error('Invalid archive snapshot ID');
  if (cursor && options.snapshotId !== undefined && cursor.snapshotId !== options.snapshotId)
    throw new Error('Archive cursor snapshot differs');
  const snapshot =
    id === null
      ? undefined
      : metadata.snapshots?.find((item) => String(item['snapshot-id']) === id);
  if (id !== null && !snapshot) throw new Error('Archive snapshot unavailable');
  const sequence = snapshot?.['sequence-number'] ?? 0;
  const watermark = options.watermark;
  if (
    watermark &&
    (metadata['table-uuid'] !== watermark.tableUuid ||
      !Number.isSafeInteger(watermark.minimumSequenceNumber) ||
      watermark.minimumSequenceNumber < 0 ||
      sequence < watermark.minimumSequenceNumber)
  )
    throw new Error('Archive snapshot is behind the committed source watermark');
  return { id, sequence };
}
function newResolver(options: SnapshotReadOptions, limits: typeof READ_LIMITS) {
  return safeReadResolver({
    store: options.store,
    ...limits,
    deadline: Date.now() + limits.deadlineMs,
    filters: new Map(),
  });
}
async function scopeDigest(
  options: SnapshotReadOptions,
  includeExpired = false,
  includeDeleted = false
): Promise<string> {
  const value = JSON.stringify([
    options.tenantKey,
    [...options.sourceDatasets].sort(),
    options.eventIds ? [...options.eventIds].sort() : null,
    options.eventAtFrom ?? null,
    options.eventAtTo ?? null,
    options.providerIngestedAtFrom ?? null,
    options.providerIngestedAtTo ?? null,
    options.nowMs,
    options.subjectIds ? [...options.subjectIds].sort() : null,
    includeExpired,
    includeDeleted,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readPage(
  options: SnapshotPageOptions & {
    resolver?: ReturnType<typeof safeReadResolver>;
    visitRow?: (
      row: LogArchiveRecord,
      path: string,
      position: bigint,
      entry: Parameters<typeof manifestMayMatch>[0]
    ) => void;
    planRows?: boolean;
    includeDeletedRows?: boolean;
  }
): Promise<SnapshotPageResult> {
  const limits = validateRead(options);
  const size = options.pageSize ?? Math.min(128, limits.maxRows);
  if (!Number.isSafeInteger(size) || size < 1 || size > 128 || size > limits.maxRows)
    throw new Error('Invalid archive page size');
  const metadata = options.table.metadata;
  const { id, sequence } = snapshotIdentity(options, options.cursor);
  const base = { tableUuid: metadata['table-uuid'], snapshotId: id, sequenceNumber: sequence };
  if (id === null) return { ...base, records: [], complete: true };
  const profile = inspectLogArchiveTable(metadata);
  const physicalFingerprint = await logArchivePhysicalFingerprint(metadata);
  const digest = await scopeDigest(
    options,
    Boolean(options.visitRow),
    Boolean(options.includeDeletedRows)
  );
  const cursor = options.cursor;
  if (
    cursor &&
    (cursor.version !== 1 ||
      cursor.tableUuid !== base.tableUuid ||
      cursor.physicalFingerprint !== physicalFingerprint ||
      cursor.scopeDigest !== digest ||
      [cursor.position.manifest, cursor.position.entry, cursor.position.row].some(
        (n) => !Number.isSafeInteger(n) || n < 0
      ) ||
      (cursor.columns?.length ?? 0) > 21)
  )
    throw new Error('Invalid archive scan cursor');
  const resolver = options.resolver ?? newResolver(options, limits);
  const providerFilter: ArchiveParquetFilter | undefined =
    profile.providerField &&
    (options.providerIngestedAtFrom !== undefined || options.providerIngestedAtTo !== undefined)
      ? {
          [profile.providerField.name]: {
            ...(options.providerIngestedAtFrom === undefined
              ? {}
              : { $gte: new Date(options.providerIngestedAtFrom) }),
            ...(options.providerIngestedAtTo === undefined
              ? {}
              : { $lt: new Date(options.providerIngestedAtTo) }),
          },
        }
      : undefined;
  const selected = await findSnapshotFile({
    metadata,
    snapshotId: id,
    resolver,
    position: cursor?.position ?? { manifest: 0, entry: 0, row: 0 },
    filter: providerFilter,
    mayMatch: (entry) =>
      manifestMayMatch(entry, options, Boolean(options.visitRow), profile.fieldIds),
  });
  if (!selected.data)
    return selected.continuation
      ? {
          ...base,
          records: [],
          complete: false,
          nextCursor: {
            version: 1,
            tableUuid: base.tableUuid,
            snapshotId: id,
            physicalFingerprint,
            scopeDigest: digest,
            position: selected.continuation,
          },
        }
      : { ...base, records: [], complete: true };
  const { entry, position } = selected.data;
  const count = Number(entry.data_file.record_count);
  if (!Number.isSafeInteger(count) || count < 0 || position.row > count)
    throw new Error('Invalid archive data-file row count');
  const queryFilter: ArchiveParquetFilter = {
    $and: [
      { tenant_key: { $eq: options.tenantKey } },
      { source_dataset: { $in: [...options.sourceDatasets] } },
      ...(options.eventIds ? [{ event_id: { $in: [...options.eventIds] } }] : []),
      ...(options.subjectIds ? [{ subject_id: { $in: [...options.subjectIds] } }] : []),
      ...(options.eventAtFrom === undefined
        ? []
        : [{ event_at: { $gte: BigInt(options.eventAtFrom) } }]),
      ...(options.eventAtTo === undefined
        ? []
        : [{ event_at: { $lt: BigInt(options.eventAtTo) } }]),
      ...(options.visitRow
        ? []
        : [
            {
              $or: [{ expires_at: { $eq: null } }, { expires_at: { $gt: BigInt(options.nowMs) } }],
            },
          ]),
    ],
  };
  const file = await resolver.openParquet(entry.data_file.file_path);
  if (Number(file.metadata.num_rows) !== count)
    throw new Error('Archive file row count differs from manifest');
  const probes = (options.eventIds ?? options.subjectIds ?? [options.tenantKey]).map((value) =>
    new TextEncoder().encode(value)
  );
  const wanted = options.eventIds ?? options.subjectIds ?? [options.tenantKey];
  const selectedRows = await readFlatFileWindow({
    file,
    profile,
    rowStart: position.row,
    rowEnd: Math.min(count, position.row + 100_000),
    filter: queryFilter,
    columns: cursor?.columns,
    select: {
      field: options.eventIds ? 'event_id' : options.subjectIds ? 'subject_id' : 'tenant_key',
      maxMatches: size,
      matches: (value) =>
        typeof value === 'string'
          ? wanted.includes(value)
          : value instanceof Uint8Array &&
            probes.some(
              (probe) =>
                probe.length === value.length && probe.every((byte, i) => byte === value[i])
            ),
    },
  });
  const deleteEntries = selected.deletes.filter(
    (item) =>
      !item.data_file.referenced_data_file ||
      item.data_file.referenced_data_file === entry.data_file.file_path
  );
  const deleteMaps: Awaited<ReturnType<typeof fetchDeleteMaps>> = options.includeDeletedRows
    ? { positionDeletesMap: new Map(), equalityDeleteGroups: [] }
    : await fetchDeleteMaps(deleteEntries, resolver);
  const positions = applicablePositionDeletes(
    entry,
    deleteMaps.positionDeletesMap.get(entry.data_file.file_path),
    metadata
  );
  const equalityGroups = deleteMaps.equalityDeleteGroups.filter((group) =>
    deleteFileAppliesToDataEntry(entry, group.deleteEntry, metadata, 'equality')
  );
  if (
    profile.providerField &&
    equalityGroups.some((group) =>
      group.rows.some((predicate) =>
        Object.keys(predicate).includes(String(profile.providerField?.id))
      )
    )
  )
    throw new Error('Provider timestamp equality deletes are unsupported');
  const columnNamesById = Object.fromEntries(
    profile.schema.fields.map((field) => [field.id, field.name])
  );
  const needsCiphertext =
    !options.planRows ||
    (!options.includeDeletedRows &&
      equalityGroups.some((group) =>
        group.rows.some((predicate) =>
          Object.hasOwn(predicate, String(profile.fieldIds.detail_ciphertext))
        )
      ));
  const groups: { start: number; end: number }[] = [];
  let nextRow = selectedRows.nextRow;
  for (const physical of selectedRows.rows) {
    const row = Number(physical.position);
    const last = groups[groups.length - 1];
    if (last && last.end === row) last.end++;
    else {
      if (groups.length === 8) {
        nextRow = row;
        break;
      }
      groups.push({ start: row, end: row + 1 });
    }
  }
  const records = new Map<string, LogArchiveRecord>();
  for (const group of groups) {
    const window = await readFlatFileWindow({
      file,
      profile,
      rowStart: group.start,
      rowEnd: group.end,
      ...(needsCiphertext
        ? {}
        : {
            projection: [
              ...LOG_ARCHIVE_FIELDS.filter((field) => field.name !== 'detail_ciphertext').map(
                (field) => field.name
              ),
              ...(profile.providerField ? [profile.providerField.name] : []),
            ],
          }),
    });
    for (const physical of window.rows) {
      resolver.check();
      if (!options.includeDeletedRows && positions.has(physical.position)) continue;
      const raw = physical.values;
      if (
        !options.includeDeletedRows &&
        equalityGroups.some((group) =>
          group.rows.some((predicate) => equalityMatch(raw, predicate, columnNamesById))
        )
      )
        continue;
      const row = rowFromParquet(
        needsCiphertext ? raw : { ...raw, detail_ciphertext: 'position-only' }
      );
      if (
        row.tenant_key !== options.tenantKey ||
        !options.sourceDatasets.includes(row.source_dataset) ||
        (options.eventIds && !options.eventIds.includes(row.event_id)) ||
        (options.subjectIds && !options.subjectIds.includes(row.subject_id ?? '')) ||
        (options.eventAtFrom !== undefined && row.event_at < options.eventAtFrom) ||
        (options.eventAtTo !== undefined && row.event_at >= options.eventAtTo)
      )
        continue;
      if (
        profile.providerField &&
        (options.providerIngestedAtFrom !== undefined || options.providerIngestedAtTo !== undefined)
      ) {
        const value = raw[profile.providerField.name];
        if (
          typeof value !== 'bigint' ||
          (options.providerIngestedAtFrom !== undefined &&
            value < BigInt(options.providerIngestedAtFrom) * 1000n) ||
          (options.providerIngestedAtTo !== undefined &&
            value >= BigInt(options.providerIngestedAtTo) * 1000n)
        )
          continue;
      }
      options.visitRow?.(row, entry.data_file.file_path, physical.position, entry);
      if (options.planRows) continue;
      if (!options.visitRow && row.expires_at !== null && row.expires_at <= options.nowMs) continue;
      const key = JSON.stringify([row.tenant_key, row.source_dataset, row.event_id]);
      const old = records.get(key);
      if (old && !sameLogicalContent(old, row))
        throw new IcebergBatchCollisionError('Archive event identity collision');
      if (!old) records.set(key, row);
    }
  }
  const nextPosition =
    nextRow >= count
      ? { manifest: position.manifest, entry: position.entry + 1, row: 0 }
      : { ...position, row: nextRow };
  return {
    ...base,
    records: [...records.values()],
    complete: false,
    nextCursor: {
      version: 1,
      tableUuid: base.tableUuid,
      snapshotId: id,
      physicalFingerprint,
      scopeDigest: digest,
      position: nextPosition,
      ...(nextPosition.row && groups.length <= 1 ? { columns: selectedRows.nextColumns } : {}),
    },
  };
}

/** Bounded page of one fixed snapshot. A continuation is explicit even when a
 * page has no matches. The caller must authenticate cursors crossing its API
 * boundary and combine logical IDs/HMACs across pages before aggregation. */
export function readSnapshotPage(options: SnapshotPageOptions): Promise<SnapshotPageResult> {
  return readPage(options);
}

/** Complete, bounded one-shot read. Budget exhaustion never becomes a partial
 * result. Large scans use the separate fixed-snapshot page API. */
async function scanSnapshotRecords(
  options: SnapshotReadOptions & {
    visitRow?: (
      row: LogArchiveRecord,
      path: string,
      position: bigint,
      entry: Parameters<typeof manifestMayMatch>[0]
    ) => void;
    planRows?: boolean;
    includeDeletedRows?: boolean;
  }
): Promise<SnapshotReadResult> {
  const limits = validateRead(options);
  const resolver = newResolver(options, limits);
  const records = new Map<string, LogArchiveRecord>();
  let cursor: SnapshotScanCursor | undefined;
  let retained = 0;
  for (let page = 0; page < 128; page++) {
    const result = await readPage({
      ...options,
      pageSize: Math.min(128, limits.maxRows),
      cursor,
      resolver,
    });
    for (const row of result.records) {
      const key = JSON.stringify([row.tenant_key, row.source_dataset, row.event_id]);
      const old = records.get(key);
      if (old && !sameLogicalContent(old, row))
        throw new IcebergBatchCollisionError('Archive event identity collision');
      if (!old) {
        retained += LOG_ARCHIVE_FIELDS.reduce(
          (n, field) =>
            n + (typeof row[field.name] === 'string' ? (row[field.name] as string).length * 2 : 16),
          128
        );
        if (records.size >= limits.maxRows || retained > 8 * 1024 * 1024)
          throw new IcebergBudgetError('Archive materialized row budget exceeded');
        records.set(key, row);
      }
    }
    if (result.complete)
      return {
        tableUuid: result.tableUuid,
        snapshotId: result.snapshotId,
        sequenceNumber: result.sequenceNumber,
        records: [...records.values()],
      };
    cursor = result.nextCursor;
  }
  throw new IcebergBudgetError('Archive complete scan requires a cursor');
}
export function readSnapshotRecords(options: SnapshotReadOptions): Promise<SnapshotReadResult> {
  return scanSnapshotRecords(options);
}

/** Source-delete proof is private and includes expired rows, including expiry
 * zero. It compares the actual logical record fields at the exact receipt
 * snapshot; public readers retain their unconditional expiry filter. */
export async function verifySnapshotBatch(
  options: SnapshotReadOptions & { expectedRecords: readonly LogArchiveRecord[] }
): Promise<Omit<SnapshotReadResult, 'records'>> {
  if (
    !options.snapshotId ||
    !options.expectedRecords.length ||
    options.expectedRecords.length > 1000
  )
    throw new Error('Invalid archive verification batch');
  const expected = new Map<string, LogArchiveRecord>();
  for (const row of options.expectedRecords) {
    assertLogArchiveRecord(row);
    if (
      row.tenant_key !== options.tenantKey ||
      !options.sourceDatasets.includes(row.source_dataset)
    )
      throw new Error('Verification batch scope differs');
    const key = JSON.stringify([row.source_dataset, row.event_id]);
    const old = expected.get(key);
    if (old && !LOG_ARCHIVE_FIELDS.every(({ name }) => old[name] === row[name]))
      throw new IcebergBatchCollisionError('Verification identity collision');
    expected.set(key, row);
  }
  let proof: SnapshotReadResult | undefined;
  for (let start = 0; start < options.expectedRecords.length; start += 100) {
    const chunk = options.expectedRecords.slice(start, start + 100);
    const found = new Set<string>();
    proof = await scanSnapshotRecords({
      ...options,
      eventIds: chunk.map((row) => row.event_id),
      visitRow: (row) => {
        const key = JSON.stringify([row.source_dataset, row.event_id]);
        const wanted = expected.get(key);
        if (!wanted) return;
        if (!LOG_ARCHIVE_FIELDS.every(({ name }) => wanted[name] === row[name]))
          throw new IcebergBatchCollisionError('Archive verification record differs');
        found.add(key);
      },
    });
    for (const row of chunk)
      if (!found.has(JSON.stringify([row.source_dataset, row.event_id])))
        throw new Error('Archive verification record missing');
  }
  if (!proof) throw new Error('Archive verification proof unavailable');
  return {
    tableUuid: proof.tableUuid,
    snapshotId: proof.snapshotId,
    sequenceNumber: proof.sequenceNumber,
  };
}

export interface SnapshotRowDelete {
  filePath: string;
  pos: string;
  partitionSpecId: number;
  partition: Record<string, unknown>;
  eventId: string;
  payloadHmac: string;
  expiresAt: number | null;
}
export interface SnapshotRowDeletePage extends Omit<SnapshotPageResult, 'records'> {
  physicalFingerprint: string;
  deletes: SnapshotRowDelete[];
}

/** Internal position planner. Ciphertext is never read unless an actual
 * equality-delete predicate requires that column. Logical expiry is a filter
 * for TTL plans and never hides an erased subject's expired physical rows. */
export async function planSnapshotRowDeletePage(
  options: SnapshotPageOptions,
  kind: 'expired' | 'subject'
): Promise<SnapshotRowDeletePage> {
  if (
    kind === 'subject' &&
    (!options.subjectIds ||
      options.subjectIds.length !== 1 ||
      options.sourceDatasets.length !== 1 ||
      options.sourceDatasets[0] !== 'pii.pii_log')
  )
    throw new Error('Invalid subject deletion scope');
  return planRowPositions(options, kind, false);
}

export function scanSnapshotSubjectFilesPage(
  options: SnapshotPageOptions
): Promise<SnapshotRowDeletePage> {
  if (
    !options.subjectIds ||
    options.subjectIds.length !== 1 ||
    options.sourceDatasets.length !== 1 ||
    options.sourceDatasets[0] !== 'pii.pii_log'
  )
    throw new Error('Invalid physical subject scope');
  return planRowPositions(options, 'subject', true);
}
/** Physical TTL inventory includes rows already hidden by position deletes. */
export function scanSnapshotExpiredFilesPage(
  options: SnapshotPageOptions
): Promise<SnapshotRowDeletePage> {
  return planRowPositions(options, 'expired', true);
}
async function planRowPositions(
  options: SnapshotPageOptions,
  kind: 'expired' | 'subject',
  includeDeletedRows: boolean
): Promise<SnapshotRowDeletePage> {
  const deletes: SnapshotRowDelete[] = [];
  const result = await readPage({
    ...options,
    planRows: true,
    includeDeletedRows,
    visitRow: (row, path, position, entry) => {
      if (kind === 'expired' && (row.expires_at === null || row.expires_at > options.nowMs)) return;
      deletes.push({
        filePath: path,
        pos: position.toString(),
        partitionSpecId: entry.partition_spec_id ?? 0,
        partition: entry.data_file.partition,
        eventId: row.event_id,
        payloadHmac: row.payload_hmac,
        expiresAt: row.expires_at,
      });
    },
  });
  const { records: _records, ...page } = result;
  return {
    ...page,
    physicalFingerprint: await logArchivePhysicalFingerprint(options.table.metadata),
    deletes,
  };
}

/** Internal TTL planner; expired rows never pass through the public reader. */
export async function planExpiredRowDeletes(
  options: SnapshotReadOptions
): Promise<{ snapshotId: string | null; deletes: { file_path: string; pos: bigint }[] }> {
  const deletes: { file_path: string; pos: bigint }[] = [];
  const result = await scanSnapshotRecords({
    ...options,
    visitRow: (row, path, position) => {
      if (row.expires_at !== null && row.expires_at <= options.nowMs)
        deletes.push({ file_path: path, pos: position });
    },
  });
  return { snapshotId: result.snapshotId, deletes };
}
