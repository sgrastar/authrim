import { applyUpdates, checkRequirements } from 'icebird/src/write/commit.js';
import { LOG_ARCHIVE_ICEBERG_SCHEMA, type LogArchiveRecord } from '../schema.js';
import {
  IcebergBudgetError,
  IcebergCatalogConflictError,
  type IcebergCatalogPort,
  type IcebergCommit,
  type IcebergObjectStore,
  type IcebergTableMetadata,
} from '../types.js';
import type {
  IcebergBatchCheckpoint,
  IcebergBatchJournal,
  IcebergBatchReceipt,
} from '../writer.js';
export const LOCATION = 's3://authrim-test/logs/events';
export function record(overrides: Partial<LogArchiveRecord> = {}): LogArchiveRecord {
  return {
    schema_version: 1,
    storage_generation: 'new-generation',
    event_id: 'event-one',
    tenant_key: 'tenant-test',
    source_dataset: 'core.event_log',
    log_type: 'audit',
    event_at: 1793000000000,
    ingested_at: 1793000001000,
    expires_at: null,
    action: 'signin',
    result: 'success',
    severity: null,
    reason_code: null,
    request_id: null,
    subject_id: null,
    client_id: null,
    resource_id: null,
    detail_ciphertext: 'encrypted-body',
    detail_key_version: '1',
    payload_hmac: 'a'.repeat(64),
    ...overrides,
  };
}
export function metadata(): IcebergTableMetadata {
  return {
    'format-version': 2,
    'table-uuid': 'bba2d8f7-861e-4b6e-9df1-48faea8ae805',
    location: LOCATION,
    'last-sequence-number': 0,
    'last-updated-ms': 1793000000000,
    'last-column-id': 20,
    'current-schema-id': 0,
    schemas: [structuredClone(LOG_ARCHIVE_ICEBERG_SCHEMA)],
    'default-spec-id': 0,
    'partition-specs': [{ 'spec-id': 0, fields: [] }],
    'last-partition-id': 999,
    'sort-orders': [{ 'order-id': 0, fields: [] }],
    'default-sort-order-id': 0,
  };
}
export class MemoryStore implements IcebergObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; identity: string }>();
  failManifestOnce = false;
  async read(path: string, maximumBytes: number): Promise<Uint8Array> {
    const object = this.objects.get(path);
    if (!object) throw new Error('missing');
    if (object.bytes.byteLength > maximumBytes) throw new IcebergBudgetError('read exceeded');
    return Uint8Array.from(object.bytes);
  }
  async putImmutable(path: string, bytes: Uint8Array, identity: string): Promise<void> {
    if (this.failManifestOnce && path.endsWith('-m0.avro')) {
      this.failManifestOnce = false;
      throw new Error('simulated manifest PUT failure');
    }
    const existing = this.objects.get(path);
    if (
      existing &&
      (existing.identity !== identity || existing.bytes.byteLength !== bytes.byteLength)
    )
      throw new Error('immutable conflict');
    if (!existing) this.objects.set(path, { bytes: Uint8Array.from(bytes), identity });
  }
}
export class MemoryJournal implements IcebergBatchJournal {
  readonly entries = new Map<string, IcebergBatchCheckpoint>();
  activeFence = 'fence-1';
  commits = 0;
  async assertFence(_batchId: string, fence: string): Promise<void> {
    if (fence !== this.activeFence) throw new Error('stale fence');
  }
  async loadOrCreate(
    candidate: IcebergBatchCheckpoint,
    fence: string
  ): Promise<IcebergBatchCheckpoint> {
    await this.assertFence(candidate.batchId, fence);
    const previous = this.entries.get(candidate.batchId);
    if (previous) return { ...previous };
    this.entries.set(candidate.batchId, { ...candidate });
    return { ...candidate };
  }
  async markCommitted(receipt: IcebergBatchReceipt, fence: string): Promise<void> {
    await this.assertFence(receipt.batchId, fence);
    const previous = this.entries.get(receipt.batchId);
    if (!previous || previous.batchDigest !== receipt.batchDigest)
      throw new Error('journal conflict');
    this.entries.set(receipt.batchId, { ...previous, ...receipt, state: 'committed' });
    this.commits++;
  }
}
export class MemoryCatalog implements IcebergCatalogPort {
  metadata = metadata();
  commitCount = 0;
  beforeCommit?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
  async loadTable() {
    return {
      metadata: structuredClone(this.metadata),
      metadataLocation: `${LOCATION}/metadata/catalog.json`,
    };
  }
  async commit(update: IcebergCommit) {
    if (this.beforeCommit) await this.beforeCommit();
    try {
      checkRequirements(this.metadata, update.requirements);
    } catch {
      throw new IcebergCatalogConflictError('CAS conflict');
    }
    const regular = update.updates.filter(
      (item): item is Exclude<typeof item, { action: 'remove-snapshot-ref' }> =>
        item.action !== 'remove-snapshot-ref'
    );
    this.metadata = applyUpdates(this.metadata, regular);
    for (const item of update.updates)
      if (item.action === 'remove-snapshot-ref' && this.metadata.refs)
        delete this.metadata.refs[item['ref-name']];
    this.commitCount++;
    if (this.afterCommit) await this.afterCommit();
    return this.loadTable();
  }
}

export function pipelineMetadata(
  first = true,
  timestamp: 'timestamp' | 'timestamptz' = 'timestamptz'
) {
  const table = metadata();
  const fields = table.schemas[0].fields.map((field) => ({
    ...field,
    id: field.id + (first ? 1 : 0),
    required: false,
  }));
  const provider = { id: first ? 1 : 21, name: '__ingest_ts', type: timestamp, required: false };
  table.schemas[0].fields = first ? [provider, ...fields] : [...fields, provider];
  table.schemas[0]['identifier-field-ids'] = [];
  table['last-column-id'] = 21;
  table['partition-specs'] = [
    {
      'spec-id': 0,
      fields: [
        { 'source-id': provider.id, 'field-id': 1000, name: '__ingest_ts_day', transform: 'day' },
      ],
    },
  ];
  return table;
}
