import { writePositionDeleteFile } from 'icebird/src/write/delete-file.js';
import { writeDeleteManifest } from 'icebird/src/write/manifest.js';
import { buildPartitionSummaries, buildSnapshotUpdate } from 'icebird/src/write/snapshot.js';
import { parseIcebergJson, stringifyIcebergJson } from 'icebird/src/json.js';
import { boundedResolver, LOG_ARCHIVE_PENDING_PIN_TTL_MS } from './writer.js';
import { inspectLogArchiveTable, logArchivePhysicalFingerprint } from './physical-schema.js';
import type { SnapshotRowDeletePage } from './reader.js';
import {
  IcebergBatchCollisionError,
  IcebergCatalogConflictError,
  IcebergCommitUnknownError,
  type IcebergCatalogPort,
  type IcebergCommit,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from './types.js';

const LIMITS = {
  maxRows: 128,
  maxInputBytes: 4 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  maxWriteBytes: 16 * 1024 * 1024,
  maxObjects: 32,
  maxCommitAttempts: 1,
};
export interface SnapshotDeleteIntent {
  version: 1;
  operationId: string;
  planDigest: string;
  snapshotId: string;
  createdAt: number;
  pinExpiresAt: number;
  plan: SnapshotRowDeletePage;
}
export interface SnapshotDeleteMutation extends SnapshotDeleteIntent {
  update: IcebergCommit;
  artifacts: string[];
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export async function createSnapshotDeleteIntent(
  plan: SnapshotRowDeletePage,
  operationId: string,
  now = Date.now()
): Promise<SnapshotDeleteIntent> {
  if (
    !/^[a-f0-9]{64}$/.test(operationId) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - LOG_ARCHIVE_PENDING_PIN_TTL_MS ||
    plan.deletes.length < 1 ||
    plan.deletes.length > LIMITS.maxRows ||
    !plan.snapshotId
  )
    throw new Error('Invalid snapshot delete intent');
  const snapshotId = BigInt('0x' + (await digest(operationId)).slice(0, 13)).toString();
  return {
    version: 1,
    operationId,
    planDigest: await deletePlanDigest(plan),
    snapshotId,
    createdAt: now,
    pinExpiresAt: now + LOG_ARCHIVE_PENDING_PIN_TTL_MS,
    plan,
  };
}
async function deletePlanDigest(plan: SnapshotRowDeletePage): Promise<string> {
  return digest(
    stringifyIcebergJson({
      tableUuid: plan.tableUuid,
      snapshotId: plan.snapshotId,
      sequenceNumber: plan.sequenceNumber,
      physicalFingerprint: plan.physicalFingerprint,
      deletes: plan.deletes,
    })
  );
}
function pin(intent: SnapshotDeleteIntent): string {
  return 'authrim-delete-' + intent.operationId;
}

/** Target partitions came from the exact fixed-snapshot reader, so no whole
 * table lookup is needed. Native Iceberg file/manifest/snapshot helpers keep
 * the v2 position-delete field IDs and sequence/partition semantics. */
export async function prepareSnapshotRowDelete(input: {
  table: IcebergLoadedTable;
  store: IcebergObjectStore;
  intent: SnapshotDeleteIntent;
}): Promise<SnapshotDeleteMutation> {
  const { table, intent } = input;
  const metadata = table.metadata;
  const profile = inspectLogArchiveTable(metadata);
  await assertIntent(intent);
  if (
    intent.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(intent.operationId) ||
    !/^\d+$/.test(intent.snapshotId) ||
    intent.plan.tableUuid !== metadata['table-uuid'] ||
    intent.plan.physicalFingerprint !== (await logArchivePhysicalFingerprint(metadata)) ||
    intent.plan.snapshotId !== String(metadata['current-snapshot-id']) ||
    intent.pinExpiresAt !== intent.createdAt + LOG_ARCHIVE_PENDING_PIN_TTL_MS ||
    Date.now() >= intent.pinExpiresAt ||
    intent.plan.deletes.length < 1 ||
    intent.plan.deletes.length > 128
  )
    throw new Error('Snapshot delete intent changed or expired');
  if (metadata.snapshots?.some((s) => String(s['snapshot-id']) === intent.snapshotId))
    throw new IcebergBatchCollisionError('Snapshot delete ID already exists');
  const groups = new Map<
    string,
    {
      spec: typeof profile.spec;
      partition: Record<string, unknown>;
      deletes: { file_path: string; pos: bigint }[];
    }
  >();
  const unique = new Set<string>();
  for (const item of intent.plan.deletes) {
    const spec = metadata['partition-specs'].find((s) => s['spec-id'] === item.partitionSpecId);
    if (
      !spec ||
      !item.filePath.startsWith(metadata.location + '/data/') ||
      !/^(0|[1-9][0-9]{0,18})$/.test(item.pos) ||
      BigInt(item.pos) > 9223372036854775807n
    )
      throw new Error('Invalid snapshot delete position');
    if (
      Object.keys(item.partition).length !== spec.fields.length ||
      spec.fields.some(
        (f) =>
          !Object.hasOwn(item.partition, f.name) ||
          (item.partition[f.name] !== null &&
            (!Number.isInteger(item.partition[f.name]) ||
              Number(item.partition[f.name]) < -2147483648 ||
              Number(item.partition[f.name]) > 2147483647))
      )
    )
      throw new Error('Invalid snapshot delete DAY partition');
    const identity = JSON.stringify([item.filePath, item.pos]);
    if (unique.has(identity)) throw new Error('Duplicate snapshot delete position');
    unique.add(identity);
    const tuple = JSON.stringify([spec['spec-id'], spec.fields.map((f) => item.partition[f.name])]);
    if (!groups.has(tuple)) groups.set(tuple, { spec, partition: item.partition, deletes: [] });
    groups.get(tuple)?.deletes.push({ file_path: item.filePath, pos: BigInt(item.pos) });
  }
  if (groups.size > 16) throw new Error('Snapshot delete partition budget exceeded');
  const resolver = boundedResolver(
    input.store,
    `position-delete:${intent.operationId}:${intent.plan.physicalFingerprint}`,
    LIMITS
  );
  const sequence = BigInt(metadata['last-sequence-number']) + 1n;
  const manifests: Parameters<typeof buildSnapshotUpdate>[0]['newManifests'] = [];
  const artifacts: string[] = [];
  let index = 0;
  let addedSize = 0n;
  for (const [tuple, group] of groups) {
    const suffix = (await digest(tuple)).slice(0, 24);
    const path = `${metadata.location}/data/authrim-${intent.operationId}-${suffix}-deletes.parquet`;
    const writer = resolver.writer(path);
    const stats = await writePositionDeleteFile({
      writer,
      deletes: group.deletes,
      codec: 'SNAPPY',
    });
    addedSize += BigInt(writer.offset);
    artifacts.push(path);
    const manifestPath = `${metadata.location}/metadata/authrim-${intent.operationId}-delete-m${index++}.avro`;
    const manifestWriter = resolver.writer(manifestPath);
    await writeDeleteManifest({
      writer: manifestWriter,
      schema: profile.schema,
      partitionSpec: group.spec,
      snapshotId: BigInt(intent.snapshotId),
      formatVersion: 2,
      deleteFiles: [
        {
          content: 1,
          file_path: path,
          file_format: 'parquet',
          partition: group.partition,
          file_size_in_bytes: BigInt(writer.offset),
          ...stats,
        },
      ],
    });
    artifacts.push(manifestPath);
    manifests.push({
      manifest_path: manifestPath,
      manifest_length: BigInt(manifestWriter.offset),
      partition_spec_id: group.spec['spec-id'],
      content: 1,
      sequence_number: sequence,
      min_sequence_number: sequence,
      added_snapshot_id: BigInt(intent.snapshotId),
      added_files_count: 1,
      existing_files_count: 0,
      deleted_files_count: 0,
      added_rows_count: BigInt(group.deletes.length),
      existing_rows_count: 0n,
      deleted_rows_count: 0n,
      partitions: buildPartitionSummaries([group.partition], profile.schema, group.spec),
    });
  }
  const current = metadata.snapshots?.find(
    (s) => String(s['snapshot-id']) === intent.plan.snapshotId
  );
  if (!current) throw new Error('Snapshot delete base missing');
  const total = (name: string): bigint =>
    BigInt((current.summary as Record<string, string | undefined>)[name] ?? '0');
  const staged = await buildSnapshotUpdate({
    tableUrl: metadata.location,
    metadata,
    resolver,
    snapshotId: BigInt(intent.snapshotId),
    sequenceNumber: sequence,
    manifestUuid: `authrim-${intent.operationId}-delete`,
    timestampMs: intent.createdAt,
    formatVersion: 2,
    newManifests: manifests,
    writtenFiles: artifacts,
    mergeManifests: false,
    summary: {
      operation: 'delete',
      'added-delete-files': String(manifests.length),
      'added-position-deletes': String(unique.size),
      'added-files-size': String(addedSize),
      'changed-partition-count': String(groups.size),
      'total-records': String(total('total-records')),
      'total-data-files': String(total('total-data-files')),
      'total-files-size': String(total('total-files-size') + addedSize),
      'total-delete-files': String(total('total-delete-files') + BigInt(manifests.length)),
      'total-position-deletes': String(total('total-position-deletes') + BigInt(unique.size)),
      'total-equality-deletes': String(total('total-equality-deletes')),
    },
  });
  (staged.snapshot.summary as Record<string, string | undefined>)['authrim.position-delete-id'] =
    intent.operationId;
  (staged.snapshot.summary as Record<string, string | undefined>)[
    'authrim.position-delete-plan-digest'
  ] = intent.planDigest;
  staged.requirements.push({
    type: 'assert-ref-snapshot-id',
    ref: pin(intent),
    'snapshot-id': null,
  });
  staged.updates.push({
    action: 'set-snapshot-ref',
    'ref-name': pin(intent),
    type: 'tag',
    'snapshot-id': staged.snapshot['snapshot-id'],
    'max-ref-age-ms': LOG_ARCHIVE_PENDING_PIN_TTL_MS,
  });
  return {
    ...intent,
    update: { requirements: staged.requirements, updates: staged.updates },
    artifacts: [...new Set([...artifacts, ...staged.writtenFiles])],
  };
}

function committed(table: IcebergLoadedTable, intent: SnapshotDeleteIntent): boolean {
  if (table.metadata['table-uuid'] !== intent.plan.tableUuid)
    throw new Error('Snapshot delete table changed');
  let id = table.metadata['current-snapshot-id'];
  const seen = new Set<string>();
  while (id !== undefined) {
    const key = String(id);
    if (seen.has(key)) throw new Error('Invalid snapshot delete ancestry');
    seen.add(key);
    const entry = table.metadata.snapshots?.find((s) => String(s['snapshot-id']) === key);
    if (!entry) break;
    if (key === intent.snapshotId) {
      if (
        (entry.summary as Record<string, string | undefined>)['authrim.position-delete-id'] !==
          intent.operationId ||
        (entry.summary as Record<string, string | undefined>)[
          'authrim.position-delete-plan-digest'
        ] !== intent.planDigest
      )
        throw new IcebergBatchCollisionError('Snapshot delete identity collision');
      return true;
    }
    id = entry['parent-snapshot-id'];
  }
  return false;
}
export async function reconcileSnapshotRowDelete(
  catalog: IcebergCatalogPort,
  intent: SnapshotDeleteIntent
): Promise<IcebergLoadedTable | null> {
  await assertIntent(intent);
  const table = await catalog.loadTable();
  if ((await logArchivePhysicalFingerprint(table.metadata)) !== intent.plan.physicalFingerprint)
    throw new Error('Snapshot delete physical schema changed');
  if (committed(table, intent)) return table;
  if (Date.now() >= intent.pinExpiresAt)
    throw new IcebergCommitUnknownError('Snapshot delete receipt expired');
  return null;
}
export async function commitSnapshotRowDelete(
  catalog: IcebergCatalogPort,
  mutation: SnapshotDeleteMutation,
  assertFence: () => Promise<void>
): Promise<IcebergLoadedTable> {
  assertMutationUpdate(mutation);
  const saved = await reconcileSnapshotRowDelete(catalog, mutation);
  if (saved) {
    await assertFence();
    return saved;
  }
  await assertFence();
  const current = await catalog.loadTable();
  if (String(current.metadata['current-snapshot-id']) !== mutation.plan.snapshotId)
    throw new IcebergCatalogConflictError('Snapshot delete base changed');
  try {
    await catalog.commit(mutation.update);
  } catch (error) {
    if (!(error instanceof IcebergCommitUnknownError)) throw error;
    const recovered = await reconcileSnapshotRowDelete(catalog, mutation);
    if (!recovered) throw error;
  }
  await assertFence();
  const result = await reconcileSnapshotRowDelete(catalog, mutation);
  if (!result) throw new IcebergCommitUnknownError('Snapshot delete outcome unavailable');
  return result;
}
export function encodeSnapshotDeleteState(
  value: SnapshotDeleteIntent | SnapshotDeleteMutation
): string {
  const text = stringifyIcebergJson(value);
  if (text.length > 256 * 1024) throw new Error('Snapshot delete state budget exceeded');
  return text;
}
export function decodeSnapshotDeleteState(
  text: string
): SnapshotDeleteIntent | SnapshotDeleteMutation {
  if (text.length > 256 * 1024) throw new Error('Snapshot delete state budget exceeded');
  const value: unknown = parseIcebergJson(text);
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('operationId' in value) ||
    typeof value.operationId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.operationId) ||
    !('plan' in value) ||
    !value.plan ||
    typeof value.plan !== 'object' ||
    !('deletes' in value.plan) ||
    !Array.isArray(value.plan.deletes) ||
    value.plan.deletes.length < 1 ||
    value.plan.deletes.length > 128
  )
    throw new Error('Invalid persisted snapshot delete state');
  return value as SnapshotDeleteIntent | SnapshotDeleteMutation;
}

async function assertIntent(intent: SnapshotDeleteIntent): Promise<void> {
  if (
    !intent ||
    intent.version !== 1 ||
    typeof intent.operationId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(intent.operationId) ||
    typeof intent.planDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(intent.planDigest) ||
    !/^\d+$/.test(intent.snapshotId) ||
    !Number.isSafeInteger(intent.createdAt) ||
    intent.createdAt < 0 ||
    !Number.isSafeInteger(intent.pinExpiresAt) ||
    intent.pinExpiresAt !== intent.createdAt + LOG_ARCHIVE_PENDING_PIN_TTL_MS ||
    !intent.plan ||
    !/^\d+$/.test(intent.plan.snapshotId ?? '') ||
    !Number.isSafeInteger(intent.plan.sequenceNumber) ||
    intent.plan.sequenceNumber < 0 ||
    !Array.isArray(intent.plan.deletes) ||
    intent.plan.deletes.length < 1 ||
    intent.plan.deletes.length > 128 ||
    !/^[a-f0-9]{64}$/.test(intent.plan.physicalFingerprint)
  )
    throw new Error('Invalid persisted snapshot delete intent');
  if (
    intent.snapshotId !==
      BigInt('0x' + (await digest(intent.operationId)).slice(0, 13)).toString() ||
    intent.planDigest !== (await deletePlanDigest(intent.plan))
  )
    throw new IcebergBatchCollisionError('Snapshot delete intent digest differs');
}
function assertMutationUpdate(mutation: SnapshotDeleteMutation): void {
  if (
    !mutation.update ||
    mutation.update.requirements.length !== 3 ||
    mutation.update.updates.length !== 3
  )
    throw new Error('Invalid snapshot delete update');
  const requirements = mutation.update.requirements;
  if (
    !requirements.some(
      (r) => r.type === 'assert-table-uuid' && r.uuid === mutation.plan.tableUuid
    ) ||
    !requirements.some(
      (r) =>
        r.type === 'assert-ref-snapshot-id' &&
        r.ref === 'main' &&
        String(r['snapshot-id']) === mutation.plan.snapshotId
    ) ||
    !requirements.some(
      (r) =>
        r.type === 'assert-ref-snapshot-id' && r.ref === pin(mutation) && r['snapshot-id'] === null
    )
  )
    throw new Error('Snapshot delete requirements differ');
  const snapshotUpdate = mutation.update.updates.find((u) => u.action === 'add-snapshot');
  if (!snapshotUpdate || snapshotUpdate.action !== 'add-snapshot')
    throw new Error('Snapshot delete payload missing');
  const snapshot = snapshotUpdate.snapshot;
  const summary = snapshot.summary as Record<string, string | undefined>;
  if (
    String(snapshot['snapshot-id']) !== mutation.snapshotId ||
    String(snapshot['parent-snapshot-id']) !== mutation.plan.snapshotId ||
    snapshot['sequence-number'] !== mutation.plan.sequenceNumber + 1 ||
    snapshot['timestamp-ms'] !== mutation.createdAt ||
    summary.operation !== 'delete' ||
    summary['authrim.position-delete-id'] !== mutation.operationId ||
    summary['authrim.position-delete-plan-digest'] !== mutation.planDigest
  )
    throw new Error('Snapshot delete payload differs');
  const refs = mutation.update.updates.filter((u) => u.action === 'set-snapshot-ref');
  if (
    refs.length !== 2 ||
    refs.some((u) => String(u['snapshot-id']) !== mutation.snapshotId) ||
    !refs.some((u) => u['ref-name'] === 'main' && u.type === 'branch') ||
    !refs.some(
      (u) =>
        u['ref-name'] === pin(mutation) &&
        u.type === 'tag' &&
        u['max-ref-age-ms'] === LOG_ARCHIVE_PENDING_PIN_TTL_MS
    )
  )
    throw new Error('Snapshot delete references differ');
}
