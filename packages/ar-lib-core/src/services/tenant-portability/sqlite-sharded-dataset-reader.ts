import { readNextPlannedSqliteDatasetChunk } from './sqlite-planned-dataset-reader';

type Single = Parameters<typeof readNextPlannedSqliteDatasetChunk>[0];
export interface SqliteDatasetShard {
  resourceId: string;
  firstOrdinal: number;
  snapshotId: string;
}

/** One logical dataset across the complete, fixed set of authoritative SQL shards. */
export async function readNextShardedSqliteDatasetChunk(
  input: Omit<Single, 'resourceId' | 'firstOrdinal' | 'snapshotId' | 'resolveSource'> & {
    shards: readonly SqliteDatasetShard[];
    resolveSource: (shard: Readonly<SqliteDatasetShard>) => ReturnType<Single['resolveSource']>;
    /** Reject missing/extra sources against the frozen authoritative topology and module plan. */
    assertResourceSet: (shards: readonly SqliteDatasetShard[]) => Promise<void>;
    /** Optional resource-aware filter for catalog rows whose object identity includes a shard. */
    filterShardRow?: (shard: Readonly<SqliteDatasetShard>, rowJson: string) => Promise<boolean>;
  },
  cursorJson: string | null
): ReturnType<typeof readNextPlannedSqliteDatasetChunk> {
  const shards = input.shards
    .map(({ resourceId, firstOrdinal, snapshotId }) =>
      Object.freeze({ resourceId, firstOrdinal, snapshotId })
    )
    .sort((a, b) => (a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0));
  if (
    !shards.length ||
    shards.length > 64 ||
    new Set(shards.map((s) => s.resourceId)).size !== shards.length ||
    shards.some(
      (s) =>
        !Number.isSafeInteger(s.firstOrdinal) ||
        s.firstOrdinal < 0 ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(s.resourceId) ||
        !/^[A-Za-z0-9_.:-]{1,256}$/.test(s.snapshotId)
    )
  )
    throw new Error('backup_sqlite_shards_invalid');
  const head = await input.inventory.headForLease(input.context.lease);
  if (head.state !== 'sealed') throw new Error('backup_sqlite_shards_unsealed');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        'authrim-sqlite-sharded-source-v1',
        input.context.lease.operationId,
        input.context.lease.tenantId,
        head.chain_digest,
        input.dataset.id,
        input.family,
        input.table,
        shards,
      ])
    )
  );
  const sourcesDigest = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  let sourceIndex = 0,
    sourceCursor: string | null = null;
  if (cursorJson !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cursorJson);
    } catch {
      throw new Error('backup_sqlite_shards_cursor');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('backup_sqlite_shards_cursor');
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).length !== 4 ||
      value.version !== 1 ||
      value.sourcesDigest !== sourcesDigest ||
      typeof value.sourceIndex !== 'number' ||
      !Number.isSafeInteger(value.sourceIndex) ||
      value.sourceIndex < 0 ||
      value.sourceIndex >= shards.length ||
      typeof value.sourceCursor !== 'string'
    )
      throw new Error('backup_sqlite_shards_cursor');
    sourceIndex = value.sourceIndex;
    sourceCursor = value.sourceCursor;
  }
  const guard = async () => {
    input.context.signal.throwIfAborted();
    await input.inventory.headForLease(input.context.lease);
    await input.assertResourceSet(Object.freeze(shards));
    input.context.signal.throwIfAborted();
  };
  await guard();
  const filterShardRow = input.filterShardRow;
  // Up to 64 empty shards can be skipped, but at most one data chunk is returned per slice.
  while (sourceIndex < shards.length) {
    const shard = shards[sourceIndex];
    const chunk = await readNextPlannedSqliteDatasetChunk(
      {
        ...input,
        ...shard,
        resolveSource: () => input.resolveSource(shard),
        ...(filterShardRow
          ? { filterRow: (rowJson: string) => filterShardRow(shard, rowJson) }
          : {}),
      },
      sourceCursor
    );
    await guard();
    if (chunk) {
      const nextCursor = JSON.stringify({
        version: 1,
        sourcesDigest,
        sourceIndex,
        sourceCursor: chunk.nextCursor,
      });
      if (nextCursor.length > 16384) throw new Error('backup_sqlite_shards_cursor_limit');
      return { bytes: chunk.bytes, nextCursor };
    }
    sourceIndex++;
    sourceCursor = null;
  }
  return null;
}
