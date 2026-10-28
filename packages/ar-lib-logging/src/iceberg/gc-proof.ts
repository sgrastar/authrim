import { inspectLogArchiveTable, logArchivePhysicalFingerprint } from './physical-schema.js';
import { safeReadResolver } from './read-buffer.js';
import type { IcebergLoadedTable, IcebergObjectStore, IcebergTableMetadata } from './types.js';

export interface IcebergSnapshotAnchor {
  tableUuid: string;
  snapshotId: string;
  sequenceNumber: number;
}
/** Sequence numbers alone cannot prove ancestry after rollback/reappend. */
export function assertIcebergSnapshotLineage(
  metadata: IcebergTableMetadata,
  anchor: IcebergSnapshotAnchor
): ReadonlySet<string> {
  if (
    metadata['table-uuid'] !== anchor.tableUuid ||
    !/^\d+$/.test(anchor.snapshotId) ||
    !Number.isSafeInteger(anchor.sequenceNumber) ||
    anchor.sequenceNumber < 0
  )
    throw new Error('Invalid Iceberg read anchor');
  let current = metadata['current-snapshot-id'];
  const path = new Set<string>();
  while (current !== undefined) {
    const id = String(current);
    if (path.has(id)) throw new Error('Invalid Iceberg anchor ancestry');
    path.add(id);
    const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === id);
    if (!snapshot) throw new Error('Iceberg anchor ancestry is incomplete');
    if (id === anchor.snapshotId) {
      if (snapshot['sequence-number'] !== anchor.sequenceNumber)
        throw new Error('Iceberg anchor sequence differs');
      return path;
    }
    current = snapshot['parent-snapshot-id'];
  }
  throw new Error('Iceberg anchor is outside current history');
}
export interface IcebergArtifactReferenceCursor {
  version: 1;
  tableUuid: string;
  snapshotId: string;
  physicalFingerprint: string;
  artifactsDigest: string;
  manifest: number;
  entry: number;
}
export interface IcebergArtifactReferencePage {
  referenced: boolean;
  referencedArtifacts?: readonly string[];
  complete: boolean;
  nextCursor?: IcebergArtifactReferenceCursor;
}
/** Metadata-only proof for an explicit artifact list. The caller must scan
 * EVERY retained snapshot, fence/revalidate catalog metadata and object identity
 * immediately before GC, and retain a durable proof. This never deletes files
 * or treats age/provider-unknown objects as ownership evidence. */
export async function scanSnapshotArtifactReferencesPage(input: {
  table: IcebergLoadedTable;
  store: IcebergObjectStore;
  snapshotId: string;
  artifacts: readonly string[];
  includeReferencedArtifacts?: boolean;
  cursor?: IcebergArtifactReferenceCursor;
}): Promise<IcebergArtifactReferencePage> {
  const metadata = input.table.metadata;
  inspectLogArchiveTable(metadata);
  if (
    input.artifacts.length < 1 ||
    input.artifacts.length > 32 ||
    input.artifacts.some((p) => !p.startsWith(metadata.location + '/') || p.length > 2048) ||
    !/^\d+$/.test(input.snapshotId)
  )
    throw new Error('Invalid artifact reference scope');
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === input.snapshotId);
  if (!snapshot?.['manifest-list']) throw new Error('Artifact reference snapshot unavailable');
  const raw = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([...input.artifacts].sort()))
  );
  const artifactsDigest = [...new Uint8Array(raw)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  const fingerprint = await logArchivePhysicalFingerprint(metadata);
  const cursor = input.cursor;
  if (
    cursor &&
    (cursor.version !== 1 ||
      cursor.tableUuid !== metadata['table-uuid'] ||
      cursor.snapshotId !== input.snapshotId ||
      cursor.physicalFingerprint !== fingerprint ||
      cursor.artifactsDigest !== artifactsDigest ||
      !Number.isSafeInteger(cursor.manifest) ||
      cursor.manifest < 0 ||
      !Number.isSafeInteger(cursor.entry) ||
      cursor.entry < 0)
  )
    throw new Error('Invalid artifact reference cursor');
  const targets = new Set(input.artifacts);
  const found = new Set<string>();
  const metadataLog = (metadata as unknown as Record<string, unknown>)['metadata-log'];
  const metadataReferenced =
    Array.isArray(metadataLog) &&
    metadataLog.some(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        'metadata-file' in entry &&
        typeof entry['metadata-file'] === 'string' &&
        targets.has(entry['metadata-file'])
    );
  if (
    metadataReferenced ||
    targets.has(snapshot['manifest-list']) ||
    targets.has(input.table.metadataLocation)
  ) {
    if (!input.includeReferencedArtifacts) return { referenced: true, complete: true };
    if (targets.has(snapshot['manifest-list'])) found.add(snapshot['manifest-list']);
    if (targets.has(input.table.metadataLocation)) found.add(input.table.metadataLocation);
    if (Array.isArray(metadataLog))
      for (const rawEntry of metadataLog) {
        const entry: unknown = rawEntry;
        if (
          entry &&
          typeof entry === 'object' &&
          'metadata-file' in entry &&
          typeof entry['metadata-file'] === 'string' &&
          targets.has(entry['metadata-file'])
        )
          found.add(entry['metadata-file']);
      }
  }
  const resolver = safeReadResolver({
    store: input.store,
    maxFiles: 32,
    maxBytes: 16 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxRows: 128,
    deadline: Date.now() + 10_000,
    filters: new Map(),
  });
  let manifestIndex = -1;
  let examined = 0;
  let entries = 0;
  let continuation: { manifest: number; entry: number } | undefined;
  for await (const batch of resolver.avroBatches(snapshot['manifest-list']))
    for (const rawManifest of batch.records) {
      resolver.check();
      manifestIndex++;
      const manifest = rawManifest as { manifest_path: string };
      if (!manifest || typeof manifest.manifest_path !== 'string')
        throw new Error('Invalid artifact manifest');
      if (targets.has(manifest.manifest_path)) {
        if (!input.includeReferencedArtifacts) return { referenced: true, complete: true };
        found.add(manifest.manifest_path);
      }
      if (manifestIndex < (cursor?.manifest ?? 0) || continuation) continue;
      if (++examined > 24) {
        continuation = { manifest: manifestIndex, entry: 0 };
        continue;
      }
      let entryIndex = -1;
      for await (const records of resolver.avroBatches(manifest.manifest_path))
        for (const value of records.records) {
          entryIndex++;
          const entry = value as { status: number; data_file: { file_path: string } };
          if (
            !entry ||
            ![0, 1, 2].includes(entry.status) ||
            typeof entry.data_file?.file_path !== 'string'
          )
            throw new Error('Invalid artifact manifest entry');
          if (manifestIndex === cursor?.manifest && entryIndex < cursor.entry) continue;
          if (continuation) continue;
          if (++entries > 256) {
            continuation = { manifest: manifestIndex, entry: entryIndex };
            continue;
          }
          if (entry.status !== 2 && targets.has(entry.data_file.file_path)) {
            if (!input.includeReferencedArtifacts) return { referenced: true, complete: true };
            found.add(entry.data_file.file_path);
          }
        }
    }
  return continuation
    ? {
        referenced: found.size > 0,
        ...(input.includeReferencedArtifacts ? { referencedArtifacts: [...found] } : {}),
        complete: false,
        nextCursor: {
          version: 1,
          tableUuid: metadata['table-uuid'],
          snapshotId: input.snapshotId,
          physicalFingerprint: fingerprint,
          artifactsDigest,
          ...continuation,
        },
      }
    : {
        referenced: found.size > 0,
        ...(input.includeReferencedArtifacts ? { referencedArtifacts: [...found] } : {}),
        complete: true,
      };
}

export interface IcebergSnapshotInventoryCursor {
  version: 1;
  tableUuid: string;
  snapshotId: string;
  physicalFingerprint: string;
  manifest: number;
  entry: number;
  listed: boolean;
}
/** Exact committed ownership inventory. Includes deleted entries: their bytes
 * must not become provider-unknown orphans when the last snapshot expires. */
export async function inventorySnapshotArtifactsPage(input: {
  table: IcebergLoadedTable;
  store: IcebergObjectStore;
  snapshotId: string;
  cursor?: IcebergSnapshotInventoryCursor;
}): Promise<{
  artifacts: string[];
  complete: boolean;
  nextCursor?: IcebergSnapshotInventoryCursor;
}> {
  const metadata = input.table.metadata;
  inspectLogArchiveTable(metadata);
  const fingerprint = await logArchivePhysicalFingerprint(metadata);
  const snapshot = metadata.snapshots?.find((s) => String(s['snapshot-id']) === input.snapshotId);
  if (!snapshot?.['manifest-list']) throw new Error('Artifact inventory snapshot unavailable');
  const cursor = input.cursor;
  if (
    cursor &&
    (cursor.version !== 1 ||
      cursor.tableUuid !== metadata['table-uuid'] ||
      cursor.snapshotId !== input.snapshotId ||
      cursor.physicalFingerprint !== fingerprint ||
      !Number.isSafeInteger(cursor.manifest) ||
      cursor.manifest < 0 ||
      !Number.isSafeInteger(cursor.entry) ||
      cursor.entry < -1 ||
      typeof cursor.listed !== 'boolean')
  )
    throw new Error('Invalid artifact inventory cursor');
  const artifacts: string[] = [];
  const add = (path: string) => {
    if (typeof path !== 'string' || !path.startsWith(metadata.location + '/') || path.length > 2048)
      throw new Error('Invalid committed artifact path');
    artifacts.push(path);
  };
  if (!cursor?.listed) add(snapshot['manifest-list']);
  const resolver = safeReadResolver({
    store: input.store,
    maxFiles: 32,
    maxBytes: 16 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxRows: 128,
    deadline: Date.now() + 10000,
    filters: new Map(),
  });
  const next = (manifest: number, entry: number) => ({
    artifacts,
    complete: false,
    nextCursor: {
      version: 1 as const,
      tableUuid: metadata['table-uuid'],
      snapshotId: input.snapshotId,
      physicalFingerprint: fingerprint,
      manifest,
      entry,
      listed: true,
    },
  });
  let manifestIndex = -1,
    examined = 0;
  for await (const batch of resolver.avroBatches(snapshot['manifest-list']))
    for (const raw of batch.records) {
      manifestIndex++;
      if (manifestIndex < (cursor?.manifest ?? 0)) continue;
      if (++examined > 24) return next(manifestIndex, -1);
      const manifest = raw as { manifest_path?: unknown };
      if (typeof manifest?.manifest_path !== 'string')
        throw new Error('Invalid inventory manifest');
      if (manifestIndex !== (cursor?.manifest ?? -1) || (cursor?.entry ?? -1) < 0) {
        if (artifacts.length === 32) return next(manifestIndex, -1);
        add(manifest.manifest_path);
      }
      let entryIndex = -1;
      for await (const records of resolver.avroBatches(manifest.manifest_path))
        for (const value of records.records) {
          entryIndex++;
          if (manifestIndex === cursor?.manifest && entryIndex < cursor.entry) continue;
          if (artifacts.length === 32) return next(manifestIndex, entryIndex);
          const entry = value as { status?: unknown; data_file?: { file_path?: unknown } };
          if (
            ![0, 1, 2].includes(Number(entry?.status)) ||
            typeof entry.data_file?.file_path !== 'string'
          )
            throw new Error('Invalid inventory entry');
          add(entry.data_file.file_path);
        }
    }
  return { artifacts, complete: true };
}
