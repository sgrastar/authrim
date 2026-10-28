import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { writeParquet } from 'icebird/src/write/parquet.js';
import { writeDataManifest } from 'icebird/src/write/manifest.js';
import { groupByPartition } from 'icebird/src/write/partition.js';
import { buildPartitionSummaries } from 'icebird/src/write/snapshot.js';
import { stringifyIcebergJson } from 'icebird/src/json.js';
import { inspectLogArchiveTable, logArchivePhysicalFingerprint } from './physical-schema.js';
import { computeColumnStats } from 'icebird/src/write/stats.js';
import { stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import { newSnapshotId } from 'icebird/src/write/stage.js';
import { safeReadResolver } from './read-buffer.js';
import { assertLogArchiveTable } from './catalog.js';
import { assertLogArchiveRecord, type LogArchiveRecord } from './schema.js';
import {
  IcebergBatchCollisionError,
  IcebergBudgetError,
  IcebergCatalogConflictError,
  IcebergCommitUnknownError,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type IcebergTableMetadata,
} from './types.js';

export interface IcebergBatchReceipt {
  batchId: string;
  batchDigest: string;
  tableUuid: string;
  snapshotId: string;
  recordCount: number;
  sequenceNumber: number;
  pinExpiresAt: number;
  pin: string;
}
export interface IcebergBatchCheckpoint extends IcebergBatchReceipt {
  schemaId: number;
  physicalFingerprint: string;
  createdAt: number;
  tenantKey: string;
  sourceDataset: string;
  storageGeneration: string;
  state: 'planned' | 'committed';
}
/** The implementation must atomically fence ALL methods and preserve immutable
 * checkpoint identity. A stale fence may neither save a receipt nor delete DB
 * source rows. loadOrCreate must return the first persisted snapshot ID. */
export interface IcebergBatchJournal {
  loadOrCreate(candidate: IcebergBatchCheckpoint, fence: string): Promise<IcebergBatchCheckpoint>;
  assertFence(batchId: string, fence: string): Promise<void>;
  markCommitted(receipt: IcebergBatchReceipt, fence: string): Promise<void>;
}
export interface IcebergWriterLimits {
  maxRows: number;
  maxInputBytes: number;
  maxFileBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxObjects: number;
  maxCommitAttempts: number;
}
export const LOG_ARCHIVE_PENDING_PIN_TTL_MS = 24 * 60 * 60 * 1000;

const DEFAULT_LIMITS: IcebergWriterLimits = {
  maxRows: 1000,
  maxInputBytes: 4 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  maxWriteBytes: 24 * 1024 * 1024,
  maxObjects: 32,
  maxCommitAttempts: 3,
};
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function canonicalRow(record: LogArchiveRecord): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
  );
}
export async function icebergBatchDigest(records: readonly LogArchiveRecord[]): Promise<string> {
  return digest(records.map(canonicalRow).join('\n'));
}
class LimitedWriter extends ByteWriter {
  constructor(private readonly maximum: number) {
    super();
  }
  override ensure(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0 || this.index + size > this.maximum)
      throw new IcebergBudgetError('Iceberg output exceeds file limit');
    super.ensure(size);
  }
}
export function boundedResolver(
  store: IcebergObjectStore,
  identity: string,
  limits: IcebergWriterLimits
) {
  let writes = 0;
  let objects = 0;
  const safeResolver = safeReadResolver({
    store,
    maxFiles: limits.maxObjects,
    maxBytes: limits.maxReadBytes,
    maxFileBytes: limits.maxFileBytes,
    maxRows: limits.maxRows,
    deadline: Date.now() + 10_000,
    filters: new Map(),
  });
  return {
    reader: (path: string) => safeResolver.reader(path),
    writer(path: string) {
      if (++objects > limits.maxObjects)
        throw new IcebergBudgetError('Iceberg object budget exceeded');
      const writer: Parameters<typeof writeParquet>[0]['writer'] = new LimitedWriter(
        limits.maxFileBytes
      );
      writer.finish = async () => {
        const bytes = writer.getBytes();
        writes += bytes.byteLength;
        if (writes > limits.maxWriteBytes)
          throw new IcebergBudgetError('Iceberg write budget exceeded');
        await store.putImmutable(path, bytes, identity);
      };
      return writer;
    },
  };
}
function receiptInCurrentHistory(
  metadata: IcebergTableMetadata,
  receipt: IcebergBatchReceipt
): boolean {
  const snapshots = metadata.snapshots ?? [];
  const matching = snapshots.filter(
    (snapshot) =>
      (snapshot.summary as Record<string, string | undefined>)['authrim.batch-id'] ===
      receipt.batchId
  );
  if (
    matching.some(
      (snapshot) =>
        (snapshot.summary as Record<string, string | undefined>)['authrim.batch-digest'] !==
          receipt.batchDigest || String(snapshot['snapshot-id']) !== receipt.snapshotId
    )
  )
    throw new IcebergBatchCollisionError('Iceberg batch identity conflict');
  let id = metadata['current-snapshot-id'];
  const seen = new Set<string>();
  while (id !== undefined) {
    const key = String(id);
    if (seen.has(key)) throw new Error('Invalid Iceberg snapshot ancestry');
    seen.add(key);
    const snapshot = snapshots.find((candidate) => String(candidate['snapshot-id']) === key);
    if (!snapshot) break;
    if (key === receipt.snapshotId) {
      const ref = metadata.refs?.[receipt.pin];
      if (
        ref?.type !== 'tag' ||
        !ref['max-ref-age-ms'] ||
        snapshot['timestamp-ms'] + ref['max-ref-age-ms'] <= Date.now() ||
        receipt.pinExpiresAt <= Date.now()
      )
        return false;
      return (
        (snapshot.summary as Record<string, string | undefined>)['authrim.batch-id'] ===
          receipt.batchId &&
        (snapshot.summary as Record<string, string | undefined>)['authrim.batch-digest'] ===
          receipt.batchDigest &&
        (snapshot.summary as Record<string, string | undefined>)['authrim.batch-records'] ===
          String(receipt.recordCount) &&
        String(metadata.refs?.[receipt.pin]?.['snapshot-id']) === receipt.snapshotId
      );
    }
    id = snapshot['parent-snapshot-id'];
  }
  return false;
}

export class ScheduledIcebergWriter {
  private readonly limits: IcebergWriterLimits;
  constructor(
    private readonly options: {
      catalog: IcebergCatalogPort;
      store: IcebergObjectStore;
      journal: IcebergBatchJournal;
      storageGeneration: string;
      tableLocation: string;
      limits?: Partial<IcebergWriterLimits>;
    }
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof IcebergWriterLimits)[]) {
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > DEFAULT_LIMITS[key]
      ) {
        throw new Error('Invalid Iceberg writer limit');
      }
    }
  }

  async appendBatch(input: {
    batchId: string;
    fence: string;
    records: readonly LogArchiveRecord[];
  }): Promise<IcebergBatchReceipt> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.batchId) ||
      input.records.length < 1 ||
      input.records.length > this.limits.maxRows
    ) {
      throw new IcebergBudgetError('Invalid Iceberg batch size or identity');
    }
    // Snapshot primitive values before the first await; caller mutation cannot
    // change a batch after its persisted digest has been fixed.
    const rows = input.records.map((row) => {
      assertLogArchiveRecord(row);
      return { ...row };
    });
    let bytes = 0;
    const ids = new Set<string>();
    for (const row of rows) {
      assertLogArchiveRecord(row);
      if (
        row.storage_generation !== this.options.storageGeneration ||
        row.tenant_key !== rows[0].tenant_key ||
        row.source_dataset !== rows[0].source_dataset
      )
        throw new Error('Iceberg batch scope mismatch');
      const key = row.event_id;
      if (ids.has(key)) throw new IcebergBatchCollisionError('Repeated event in Iceberg batch');
      ids.add(key);
      bytes += new TextEncoder().encode(canonicalRow(row)).byteLength + 1;
      if (bytes > this.limits.maxInputBytes)
        throw new IcebergBudgetError('Iceberg input budget exceeded');
    }
    const batchDigest = await icebergBatchDigest(rows);
    let loaded = await this.options.catalog.loadTable();
    assertLogArchiveTable(loaded.metadata);
    if (loaded.metadata.location !== this.options.tableLocation)
      throw new Error('Iceberg table location changed');
    const first = rows[0];
    const artifactId = await digest(input.batchId);
    const createdAt = Date.now();
    const physicalFingerprint = await logArchivePhysicalFingerprint(loaded.metadata);
    const candidate: IcebergBatchCheckpoint = {
      batchId: input.batchId,
      batchDigest,
      tableUuid: loaded.metadata['table-uuid'],
      snapshotId: String(newSnapshotId(loaded.metadata)),
      recordCount: input.records.length,
      sequenceNumber: 0,
      schemaId: loaded.metadata['current-schema-id'],
      physicalFingerprint,
      createdAt,
      pinExpiresAt: createdAt + LOG_ARCHIVE_PENDING_PIN_TTL_MS,
      tenantKey: first.tenant_key,
      sourceDataset: first.source_dataset,
      storageGeneration: first.storage_generation,
      pin: `authrim-pending-${artifactId}`,
      state: 'planned',
    };
    const checkpoint = await this.options.journal.loadOrCreate(candidate, input.fence);
    for (const key of [
      'batchId',
      'batchDigest',
      'tableUuid',
      'recordCount',
      'schemaId',
      'physicalFingerprint',
      'tenantKey',
      'sourceDataset',
      'storageGeneration',
      'pin',
    ] as const) {
      if (candidate[key] !== checkpoint[key])
        throw new IcebergBatchCollisionError('Iceberg checkpoint identity conflict');
    }
    if (
      !/^\d+$/.test(checkpoint.snapshotId) ||
      !Number.isSafeInteger(Number(checkpoint.snapshotId)) ||
      Number(checkpoint.snapshotId) <= 0
    ) {
      throw new Error('Invalid persisted Iceberg snapshot ID');
    }
    if (
      !Number.isSafeInteger(checkpoint.pinExpiresAt) ||
      checkpoint.pinExpiresAt <= Date.now() ||
      checkpoint.pinExpiresAt - checkpoint.createdAt > LOG_ARCHIVE_PENDING_PIN_TTL_MS
    ) {
      throw new IcebergCommitUnknownError(
        'Pending Iceberg batch pin lease expired; source must be retained'
      );
    }
    if (
      !Number.isSafeInteger(checkpoint.createdAt) ||
      checkpoint.createdAt < 0 ||
      (checkpoint.state !== 'planned' && checkpoint.state !== 'committed')
    )
      throw new Error('Invalid Iceberg checkpoint state');
    const receipt: IcebergBatchReceipt = checkpoint;
    if (receiptInCurrentHistory(loaded.metadata, receipt)) {
      await this.options.journal.markCommitted(
        { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] },
        input.fence
      );
      return { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] };
    }
    if (checkpoint.state === 'committed')
      throw new IcebergCommitUnknownError('Committed batch requires reconciliation');
    const profile = inspectLogArchiveTable(loaded.metadata);
    const records = rows.map((row) => ({
      ...row,
      event_at: BigInt(row.event_at),
      ingested_at: BigInt(row.ingested_at),
      expires_at: row.expires_at === null ? null : BigInt(row.expires_at),
      ...(profile.providerField ? { [profile.providerField.name]: new Date(row.ingested_at) } : {}),
    }));
    const resolver = boundedResolver(
      this.options.store,
      `${checkpoint.tableUuid}:${batchDigest}`,
      this.limits
    );
    const schema = loaded.metadata.schemas.find((s) => s['schema-id'] === checkpoint.schemaId);
    const spec = loaded.metadata['partition-specs'].find(
      (s) => s['spec-id'] === loaded.metadata['default-spec-id']
    );
    if (!schema || !spec) throw new Error('Iceberg schema or partition missing');
    await this.options.journal.assertFence(input.batchId, input.fence);
    const groups = groupByPartition(records, schema, spec);
    if (groups.length > 16) throw new IcebergBudgetError('Archive partition group budget exceeded');
    const dataFiles: Parameters<typeof writeDataManifest>[0]['dataFiles'] = [];
    const dataPaths: string[] = [];
    for (const group of groups) {
      const partitionKey = await digest(stringifyIcebergJson(group.partition));
      const dataPath = `${this.options.tableLocation}/data/authrim-${artifactId}-${partitionKey}.parquet`;
      const dataWriter = resolver.writer(dataPath);
      await writeParquet({ writer: dataWriter, schema, records: group.records, codec: 'SNAPPY' });
      const stats = computeColumnStats(group.records, schema);
      for (const name of ['detail_ciphertext', 'payload_hmac'] as const) {
        delete stats.lower_bounds[profile.fieldIds[name]];
        delete stats.upper_bounds[profile.fieldIds[name]];
      }
      dataPaths.push(dataPath);
      dataFiles.push({
        content: 0,
        file_path: dataPath,
        file_format: 'parquet',
        partition: group.partition,
        record_count: BigInt(group.records.length),
        file_size_in_bytes: BigInt(dataWriter.offset),
        sort_order_id: 0,
        ...stats,
      });
    }
    const dataBytes = dataFiles.reduce((sum, file) => sum + file.file_size_in_bytes, 0n);
    const manifestPath = `${this.options.tableLocation}/metadata/authrim-${artifactId}-m0.avro`;
    const manifestWriter = resolver.writer(manifestPath);
    await writeDataManifest({
      writer: manifestWriter,
      schema,
      partitionSpec: spec,
      snapshotId: BigInt(checkpoint.snapshotId),
      formatVersion: 2,
      dataFiles,
    });
    const prepared: Parameters<typeof stageSnapshotForAppend>[0]['prepared'] = {
      snapshotId: BigInt(checkpoint.snapshotId),
      manifestUuid: artifactId,
      formatVersion: 2,
      manifestPath,
      manifestLength: BigInt(manifestWriter.offset),
      partitionSpecId: spec['spec-id'],
      partitions: buildPartitionSummaries(
        groups.map((group) => group.partition),
        schema,
        spec
      ),
      dataFilePartitions: groups.map((group) => group.partition),
      addedDataFilesCount: dataFiles.length,
      addedRowCount: BigInt(records.length),
      addedFilesSize: dataBytes,
      recordsCount: records.length,
      writtenFiles: [...dataPaths, manifestPath],
    };
    for (let attempt = 0; attempt < this.limits.maxCommitAttempts; attempt++) {
      assertLogArchiveTable(loaded.metadata);
      if ((await logArchivePhysicalFingerprint(loaded.metadata)) !== checkpoint.physicalFingerprint)
        throw new IcebergBatchCollisionError('Iceberg physical schema changed during batch');
      if (
        loaded.metadata['table-uuid'] !== checkpoint.tableUuid ||
        loaded.metadata.location !== this.options.tableLocation ||
        loaded.metadata['current-schema-id'] !== checkpoint.schemaId
      )
        throw new IcebergBatchCollisionError('Iceberg table changed during batch');
      if (receiptInCurrentHistory(loaded.metadata, receipt)) {
        await this.options.journal.markCommitted(
          { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] },
          input.fence
        );
        return { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] };
      }
      await this.options.journal.assertFence(input.batchId, input.fence);
      // A CAS retry must never overwrite the preceding attempt's manifest list.
      const base = String(loaded.metadata['current-snapshot-id'] ?? 'none');
      const attemptId = `${artifactId}-${loaded.metadata['last-sequence-number']}-${base}`;
      const staged = await stageSnapshotForAppend({
        tableUrl: this.options.tableLocation,
        metadata: {
          ...loaded.metadata,
          properties: { ...loaded.metadata.properties, 'commit.manifest-merge.enabled': 'false' },
        },
        prepared: { ...prepared, manifestUuid: attemptId },
        resolver,
      });
      staged.snapshot['timestamp-ms'] = checkpoint.createdAt;
      (staged.snapshot.summary as Record<string, string | undefined>)['authrim.batch-id'] =
        receipt.batchId;
      (staged.snapshot.summary as Record<string, string | undefined>)['authrim.batch-digest'] =
        receipt.batchDigest;
      (staged.snapshot.summary as Record<string, string | undefined>)['authrim.batch-records'] =
        String(receipt.recordCount);
      staged.updates.push({
        action: 'set-snapshot-ref',
        'ref-name': receipt.pin,
        type: 'tag',
        'snapshot-id': staged.snapshot['snapshot-id'],
        'max-ref-age-ms': checkpoint.pinExpiresAt - checkpoint.createdAt,
      });
      await this.options.journal.assertFence(input.batchId, input.fence);
      if (checkpoint.pinExpiresAt <= Date.now())
        throw new IcebergCommitUnknownError('Pending batch pin expired before commit');
      try {
        await this.options.catalog.commit(staged);
      } catch (error) {
        // A network failure may conceal success; verify on a fresh read before
        // either retrying the SAME snapshot or allowing any source deletion.
        if (
          !(error instanceof IcebergCatalogConflictError) &&
          !(error instanceof IcebergCommitUnknownError)
        )
          throw error;
        loaded = await this.options.catalog.loadTable();
        if (receiptInCurrentHistory(loaded.metadata, receipt)) {
          await this.options.journal.markCommitted(
            { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] },
            input.fence
          );
          return { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] };
        }
        if (error instanceof IcebergCommitUnknownError) throw error;
        continue;
      }
      loaded = await this.options.catalog.loadTable();
      if (!receiptInCurrentHistory(loaded.metadata, receipt))
        throw new IcebergCommitUnknownError('Iceberg batch not confirmed in current history');
      await this.options.journal.markCommitted(
        { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] },
        input.fence
      );
      return { ...receipt, sequenceNumber: loaded.metadata['last-sequence-number'] };
    }
    throw new IcebergCatalogConflictError('Iceberg batch CAS retry budget exhausted');
  }
}
