import { buildSnapshotUpdate } from 'icebird/src/write/snapshot.js';
import { boundedResolver } from './writer.js';
import { inspectLogArchiveTable } from './physical-schema.js';
import { assertIcebergSnapshotLineage } from './gc-proof.js';
import {
  IcebergCatalogConflictError,
  IcebergCommitUnknownError,
  type IcebergCatalogPort,
  type IcebergObjectStore,
  type IcebergLoadedTable,
} from './types.js';

/** A fresh main CAS closes old in-flight commits before orphan reclamation.
 * It works for an empty new table as well as an existing snapshot. */
export async function advanceIcebergMainForGc(input: {
  catalog: IcebergCatalogPort;
  store: IcebergObjectStore;
  operationId: string;
  assertFence: () => Promise<void>;
}): Promise<{ table: IcebergLoadedTable; snapshotId: string; sequenceNumber: number }> {
  if (!/^[a-f0-9]{64}$/.test(input.operationId)) throw new Error('Invalid Iceberg GC fence');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.operationId));
  const id = BigInt(
    '0x' +
      [...new Uint8Array(digest)]
        .map((v) => v.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 13)
  ).toString();
  const existing = (table: IcebergLoadedTable) => {
    const snapshot = table.metadata.snapshots?.find((s) => String(s['snapshot-id']) === id);
    if (!snapshot) return undefined;
    if (
      (snapshot.summary as Record<string, string | undefined>)['authrim.gc-fence-id'] !==
      input.operationId
    )
      throw new Error('Iceberg GC fence collision');
    assertIcebergSnapshotLineage(table.metadata, {
      tableUuid: table.metadata['table-uuid'],
      snapshotId: id,
      sequenceNumber: snapshot['sequence-number'] ?? 0,
    });
    return { table, snapshotId: id, sequenceNumber: snapshot['sequence-number'] ?? 0 };
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const table = await input.catalog.loadTable();
    inspectLogArchiveTable(table.metadata);
    const done = existing(table);
    if (done) {
      await input.assertFence();
      return done;
    }
    const metadata = table.metadata;
    const current = metadata.snapshots?.find(
      (s) => String(s['snapshot-id']) === String(metadata['current-snapshot-id'])
    );
    const resolver = boundedResolver(
      input.store,
      `${metadata['table-uuid']}:gc-fence:${input.operationId}`,
      {
        maxRows: 1000,
        maxInputBytes: 4 * 1024 * 1024,
        maxFileBytes: 8 * 1024 * 1024,
        maxReadBytes: 16 * 1024 * 1024,
        maxWriteBytes: 16 * 1024 * 1024,
        maxObjects: 32,
        maxCommitAttempts: 1,
      }
    );
    await input.assertFence();
    const summary = {
      ...current?.summary,
      operation: 'append',
      'added-data-files': '0',
      'added-records': '0',
      'added-files-size': '0',
    };
    for (const key of Object.keys(summary))
      if (key.startsWith('authrim.batch-') || key.startsWith('authrim.position-delete-'))
        delete (summary as Record<string, string | undefined>)[key];
    (summary as Record<string, string | undefined>)['authrim.gc-fence-id'] = input.operationId;
    const staged = await buildSnapshotUpdate({
      tableUrl: metadata.location,
      metadata,
      resolver,
      snapshotId: BigInt(id),
      sequenceNumber: BigInt(metadata['last-sequence-number']) + 1n,
      manifestUuid: `gc-${input.operationId}-${metadata['last-sequence-number']}-${String(metadata['current-snapshot-id'] ?? 'empty')}`,
      timestampMs: Date.now(),
      formatVersion: 2,
      newManifests: [],
      writtenFiles: [],
      mergeManifests: false,
      summary,
    });
    await input.assertFence();
    try {
      await input.catalog.commit(staged);
    } catch (error) {
      if (error instanceof IcebergCatalogConflictError) continue;
      if (!(error instanceof IcebergCommitUnknownError)) throw error;
      const recovered = existing(await input.catalog.loadTable());
      if (!recovered) throw error;
    }
    await input.assertFence();
    const result = existing(await input.catalog.loadTable());
    if (result) return result;
    throw new IcebergCommitUnknownError('Iceberg GC fence outcome unavailable');
  }
  throw new IcebergCatalogConflictError('Iceberg GC fence changed repeatedly');
}
