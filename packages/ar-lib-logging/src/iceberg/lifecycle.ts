import { assertIcebergSnapshotLineage, type IcebergSnapshotAnchor } from './gc-proof.js';
import { buildSnapshotUpdate } from 'icebird/src/write/snapshot.js';
import { icebergStageExpireSnapshots, newSnapshotId } from 'icebird/src/write/stage.js';
import { icebergStagePositionDelete } from 'icebird/src/write/stage-position-delete.js';
import { icebergStageRewrite } from 'icebird/src/write/rewrite.js';
import { assertLogArchiveTable } from './catalog.js';
import {
  boundedResolver,
  LOG_ARCHIVE_PENDING_PIN_TTL_MS,
  type IcebergBatchReceipt,
} from './writer.js';
import { planExpiredRowDeletes, type SnapshotReadOptions } from './reader.js';
import {
  IcebergCommitUnknownError,
  type IcebergCatalogPort,
  type IcebergCommit,
  type IcebergLoadedTable,
  type IcebergObjectStore,
} from './types.js';

const LIFECYCLE_LIMITS = {
  maxRows: 1000,
  maxInputBytes: 4 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  maxWriteBytes: 24 * 1024 * 1024,
  maxObjects: 64,
  maxCommitAttempts: 1,
};

/** Metadata/data maintenance uses catalog CAS, never raw R2 deletion. All Authrim
 * DR pin writers must use pinSnapshot's main-advance barrier. */
export class IcebergLifecycle {
  constructor(
    private readonly options: {
      catalog: IcebergCatalogPort;
      store: IcebergObjectStore;
      tableLocation: string;
    }
  ) {}
  private async load(): Promise<IcebergLoadedTable> {
    const table = await this.options.catalog.loadTable();
    assertLogArchiveTable(table.metadata);
    if (table.metadata.location !== this.options.tableLocation)
      throw new Error('Iceberg lifecycle table location changed');
    return table;
  }
  private async commit(update: IcebergCommit): Promise<IcebergLoadedTable> {
    await this.options.catalog.commit(update);
    return this.load();
  }
  /** A DR tag is created together with a zero-data snapshot advance. A concurrent
   * expiration based on the previous main snapshot must then fail its CAS. */
  async pinSnapshot(
    ref: string,
    snapshotId: string,
    maxAgeMs = LOG_ARCHIVE_PENDING_PIN_TTL_MS
  ): Promise<IcebergLoadedTable> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(ref) ||
      ref === 'main' ||
      ref.startsWith('authrim-pending-') ||
      !/^\d+$/.test(snapshotId)
    ) {
      throw new Error('Invalid DR snapshot pin');
    }
    if (
      !Number.isSafeInteger(maxAgeMs) ||
      maxAgeMs < 1 ||
      maxAgeMs > LOG_ARCHIVE_PENDING_PIN_TTL_MS
    )
      throw new Error('Invalid DR pin lease');
    const table = await this.load();
    const metadata = table.metadata;
    const target = metadata.snapshots?.find(
      (snapshot) => String(snapshot['snapshot-id']) === snapshotId
    );
    if (!target) throw new Error('DR snapshot missing');
    const existing = metadata.refs?.[ref];
    if (existing) {
      const pinned = metadata.snapshots?.find(
        (snapshot) => String(snapshot['snapshot-id']) === String(existing['snapshot-id'])
      );
      const summary = pinned?.summary as Record<string, string | undefined> | undefined;
      if (existing.type !== 'tag' || summary?.['authrim.dr-source-snapshot-id'] !== snapshotId)
        throw new Error('DR pin identity collision');
      if (!pinned || pinned['timestamp-ms'] + (existing['max-ref-age-ms'] ?? 0) <= Date.now())
        throw new Error('DR pin lease expired');
      return table;
    }
    const current = metadata.snapshots?.find(
      (snapshot) => String(snapshot['snapshot-id']) === String(metadata['current-snapshot-id'])
    );
    if (!current) throw new Error('DR current snapshot missing');
    const resolver = boundedResolver(
      this.options.store,
      `dr-pin:${ref}:${snapshotId}`,
      LIFECYCLE_LIMITS
    );
    const capturedAt = Date.now();
    const cloneId = newSnapshotId(metadata);
    const clone = {
      ...target,
      'snapshot-id': Number(cloneId),
      'sequence-number': metadata['last-sequence-number'] + 1,
      'timestamp-ms': capturedAt,
      'parent-snapshot-id': target['snapshot-id'],
      summary: {
        ...target.summary,
        operation: 'append',
        'added-data-files': '0',
        'added-records': '0',
        'added-files-size': '0',
        'authrim.dr-source-snapshot-id': snapshotId,
      },
    };
    for (const key of Object.keys(clone.summary))
      if (key.startsWith('authrim.batch-'))
        delete (clone.summary as Record<string, string | undefined>)[key];
    const staged = await buildSnapshotUpdate({
      tableUrl: metadata.location,
      metadata,
      resolver,
      snapshotId: newSnapshotId({ ...metadata, snapshots: [...(metadata.snapshots ?? []), clone] }),
      sequenceNumber: BigInt(metadata['last-sequence-number']) + 2n,
      manifestUuid: crypto.randomUUID(),
      timestampMs: Date.now(),
      formatVersion: 2,
      newManifests: [],
      writtenFiles: [],
      mergeManifests: false,
      summary: {
        ...current.summary,
        operation: 'append',
        'added-data-files': '0',
        'added-records': '0',
        'added-files-size': '0',
      },
    });
    // Do not copy another batch's receipt onto the barrier snapshot.
    for (const key of Object.keys(staged.snapshot.summary))
      if (key.startsWith('authrim.batch-'))
        delete (staged.snapshot.summary as Record<string, string | undefined>)[key];
    staged.updates.unshift({ action: 'add-snapshot', snapshot: clone });
    staged.requirements.push({ type: 'assert-ref-snapshot-id', ref, 'snapshot-id': null });
    staged.updates.push({
      action: 'set-snapshot-ref',
      'ref-name': ref,
      type: 'tag',
      'snapshot-id': clone['snapshot-id'],
      'max-ref-age-ms': maxAgeMs,
    });
    try {
      return await this.commit(staged);
    } catch (error) {
      if (!(error instanceof IcebergCommitUnknownError)) throw error;
      const fresh = await this.load();
      if (String(fresh.metadata.refs?.[ref]?.['snapshot-id']) === String(clone['snapshot-id']))
        return fresh;
      throw error;
    }
  }
  async releaseSnapshotPin(ref: string, snapshotId: string, tableUuid: string): Promise<void> {
    if (ref === 'main' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref))
      throw new Error('Invalid snapshot pin release');
    const table = await this.load();
    if (table.metadata['table-uuid'] !== tableUuid)
      throw new Error('Snapshot pin table identity mismatch');
    const current = table.metadata.refs?.[ref];
    if (!current) return;
    if (String(current['snapshot-id']) !== snapshotId) throw new Error('Snapshot pin changed');
    const update: IcebergCommit = {
      requirements: [
        { type: 'assert-table-uuid', uuid: tableUuid },
        // Do not remove a recovery pin across a concurrent main rollback/append.
        // The caller's verified lineage must still describe this exact commit.
        {
          type: 'assert-ref-snapshot-id',
          ref: 'main',
          'snapshot-id':
            table.metadata.refs?.main?.['snapshot-id'] ??
            table.metadata['current-snapshot-id'] ??
            null,
        },
        { type: 'assert-ref-snapshot-id', ref, 'snapshot-id': current['snapshot-id'] },
      ],
      updates: [{ action: 'remove-snapshot-ref', 'ref-name': ref }],
    };
    try {
      await this.commit(update);
    } catch (error) {
      if (!(error instanceof IcebergCommitUnknownError)) throw error;
      const fresh = await this.load();
      if (fresh.metadata.refs?.[ref]) throw error;
    }
  }
  /** Caller must first atomically delete exactly the verified source IDs and
   * record its read watermark. This method never deletes source DB rows. */
  async releaseBatchPin(receipt: IcebergBatchReceipt, sourceDeleted: true): Promise<void> {
    if (sourceDeleted !== true || !receipt.pin.startsWith('authrim-pending-'))
      throw new Error('Source deletion must precede batch pin release');
    await this.releaseSnapshotPin(receipt.pin, receipt.snapshotId, receipt.tableUuid);
  }
  async deleteExpiredRows(
    scope: Omit<SnapshotReadOptions, 'table' | 'store' | 'snapshotId'>
  ): Promise<number> {
    const table = await this.load();
    const plan = await planExpiredRowDeletes({ ...scope, table, store: this.options.store });
    if (plan.deletes.length === 0) return 0;
    if (plan.deletes.length > LIFECYCLE_LIMITS.maxRows)
      throw new Error('Expired row delete budget exceeded');
    const resolver = boundedResolver(
      this.options.store,
      `expiry:${crypto.randomUUID()}`,
      LIFECYCLE_LIMITS
    );
    const staged = await icebergStagePositionDelete({
      tableUrl: table.metadata.location,
      metadata: table.metadata,
      resolver,
      deletes: plan.deletes,
    });
    // Delete positions belong to precisely this snapshot. Never replay against a
    // new snapshot after a conflict or unknown response; re-plan a fresh scan.
    await this.commit(staged);
    return plan.deletes.length;
  }
  async rewriteFiles(files: readonly string[]): Promise<void> {
    if (files.length < 1 || files.length > 16 || new Set(files).size !== files.length)
      throw new Error('Invalid rewrite file budget');
    const table = await this.load();
    const resolver = boundedResolver(
      this.options.store,
      `rewrite:${crypto.randomUUID()}`,
      LIFECYCLE_LIMITS
    );
    const staged = await icebergStageRewrite({
      tableUrl: table.metadata.location,
      metadata: table.metadata,
      resolver,
      files: [...files],
      targetFileRows: LIFECYCLE_LIMITS.maxRows,
    });
    await this.commit(staged);
  }
  /** Files are intentionally retained here. Catalog-managed maintenance or a
   * separate full reachability collector may reclaim unreferenced objects. */
  async expireSnapshots(
    olderThanMs: number,
    protectedAnchors: readonly IcebergSnapshotAnchor[] = [],
    maximumSnapshots = 128,
    protectedSnapshotIds: readonly string[] = []
  ): Promise<number> {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0)
      throw new Error('Invalid snapshot expiration cutoff');
    if (!Number.isSafeInteger(maximumSnapshots) || maximumSnapshots < 1 || maximumSnapshots > 1000)
      throw new Error('Invalid snapshot expiry budget');
    let table = await this.load();
    if (protectedAnchors.length > 128) throw new Error('Iceberg anchor budget exceeded');
    for (const anchor of protectedAnchors) assertIcebergSnapshotLineage(table.metadata, anchor);
    const expiredRefs = Object.entries(table.metadata.refs ?? {}).filter(([name, ref]) => {
      if (name === 'main' || ref['max-ref-age-ms'] === undefined) return false;
      const snapshot = table.metadata.snapshots?.find(
        (entry) => String(entry['snapshot-id']) === String(ref['snapshot-id'])
      );
      return (
        snapshot !== undefined && snapshot['timestamp-ms'] + ref['max-ref-age-ms'] <= Date.now()
      );
    });
    if (expiredRefs.length > 128) throw new Error('Expired snapshot pin budget exceeded');
    if (expiredRefs.length) {
      await this.commit({
        requirements: [
          { type: 'assert-table-uuid', uuid: table.metadata['table-uuid'] },
          ...expiredRefs.map(([ref, value]) => ({
            type: 'assert-ref-snapshot-id' as const,
            ref,
            'snapshot-id': value['snapshot-id'],
          })),
        ],
        updates: expiredRefs.map(([ref]) => ({
          action: 'remove-snapshot-ref' as const,
          'ref-name': ref,
        })),
      });
      table = await this.load();
    }
    const metadata = table.metadata;
    if (
      protectedSnapshotIds.length > 4096 ||
      protectedSnapshotIds.some(
        (id) =>
          !/^\d+$/.test(id) || !metadata.snapshots?.some((s) => String(s['snapshot-id']) === id)
      )
    )
      throw new Error('Invalid protected snapshot inventory');
    const refs = new Set(
      Object.values(metadata.refs ?? {}).map((ref) => String(ref['snapshot-id']))
    );
    for (const id of protectedSnapshotIds) refs.add(id);
    if (metadata['current-snapshot-id'] !== undefined)
      refs.add(String(metadata['current-snapshot-id']));
    // Pending DB batches must remain provably in current main history. Keeping
    // just their tag target is insufficient: expiring an intermediate ancestor
    // would sever the chain used to reconcile an acknowledged-but-unrecorded
    // append. Preserve the path from main through every pending batch target.
    const pending = new Set(
      Object.entries(metadata.refs ?? {})
        .filter(
          ([name]) => name.startsWith('authrim-pending-') || name.startsWith('authrim-delete-')
        )
        .map(([, ref]) => String(ref['snapshot-id']))
    );
    for (const anchor of protectedAnchors)
      for (const id of assertIcebergSnapshotLineage(metadata, anchor)) refs.add(id);
    let cursor = metadata['current-snapshot-id'];
    const visited = new Set<string>();
    while (pending.size > 0 && cursor !== undefined) {
      const key = String(cursor);
      if (visited.has(key)) throw new Error('Invalid pending batch ancestry');
      visited.add(key);
      refs.add(key);
      pending.delete(key);
      const snapshot = metadata.snapshots?.find((entry) => String(entry['snapshot-id']) === key);
      if (!snapshot) throw new Error('Pending batch ancestry is incomplete');
      cursor = snapshot['parent-snapshot-id'];
    }
    if (pending.size > 0) throw new Error('Pending batch is outside current history');
    const snapshots =
      metadata.snapshots?.filter(
        (snapshot) =>
          snapshot['timestamp-ms'] < olderThanMs && !refs.has(String(snapshot['snapshot-id']))
      ) ?? [];
    snapshots.sort((a, b) => a['timestamp-ms'] - b['timestamp-ms']);
    snapshots.splice(maximumSnapshots);
    if (snapshots.length === 0) return 0;
    const staged = icebergStageExpireSnapshots({
      metadata,
      snapshotIds: snapshots.map((snapshot) => snapshot['snapshot-id']),
    });
    // Existing pins are also fenced. New Authrim pins advance main atomically.
    for (const [ref, value] of Object.entries(metadata.refs ?? {}))
      if (ref !== 'main') {
        staged.requirements.push({
          type: 'assert-ref-snapshot-id',
          ref,
          'snapshot-id': value['snapshot-id'],
        });
      }
    await this.commit(staged);
    return snapshots.length;
  }
}
