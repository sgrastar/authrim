import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { describe, expect, it } from 'vitest';
import {
  createSnapshotDeleteIntent,
  prepareSnapshotRowDelete,
  commitSnapshotRowDelete,
  encodeSnapshotDeleteState,
  decodeSnapshotDeleteState,
} from '../position-delete.js';
import {
  planSnapshotRowDeletePage,
  scanSnapshotSubjectFilesPage,
  readSnapshotRecords,
  type SnapshotScanCursor,
} from '../reader.js';
import { scanSnapshotArtifactReferencesPage, assertIcebergSnapshotLineage } from '../gc-proof.js';
import { ScheduledIcebergWriter } from '../writer.js';
import { IcebergLifecycle } from '../lifecycle.js';
import { IcebergCommitUnknownError } from '../types.js';
import {
  MemoryCatalog,
  MemoryStore,
  MemoryJournal,
  record,
  LOCATION,
  pipelineMetadata,
} from './fixtures.js';

const subject = 'd0a48aee-cfee-47f4-b28f-d1891473f2bd';
async function setup(pipeline = false) {
  const catalog = new MemoryCatalog();
  if (pipeline) catalog.metadata = pipelineMetadata();
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: LOCATION,
  });
  const rows = [
    record({
      event_id: 'expired',
      subject_id: subject,
      source_dataset: 'pii.pii_log',
      expires_at: 0,
    }),
    record({ event_id: 'keep', subject_id: 'other', source_dataset: 'pii.pii_log' }),
    record({
      event_id: 'foreign',
      subject_id: subject,
      source_dataset: 'pii.pii_log',
      tenant_key: 'foreign',
    }),
  ].map((r) => ({
    ...r,
    event_at: BigInt(r.event_at),
    ingested_at: BigInt(r.ingested_at),
    expires_at: r.expires_at === null ? null : BigInt(r.expires_at),
    ...(pipeline ? { __ingest_ts: new Date(r.ingested_at) } : {}),
  }));
  const resolver = {
    writer(path: string) {
      const output = new ByteWriter();
      return Object.assign(output, {
        finish: async () => store.putImmutable(path, output.getBytes(), path),
      });
    },
  };
  const prepared = await prepareAppend({
    tableUrl: LOCATION,
    metadata: catalog.metadata,
    resolver,
    records: rows,
  });
  await catalog.commit(
    await stageSnapshotForAppend({
      tableUrl: LOCATION,
      metadata: catalog.metadata,
      resolver,
      prepared,
    })
  );
  return { catalog, store, writer };
}
async function plan(f: Awaited<ReturnType<typeof setup>>) {
  let cursor: SnapshotScanCursor | undefined;
  for (let i = 0; i < 10; i++) {
    const page = await planSnapshotRowDeletePage(
      {
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'tenant-test',
        sourceDatasets: ['pii.pii_log'],
        subjectIds: [subject],
        nowMs: 0,
        cursor,
      },
      'subject'
    );
    if (page.deletes.length || page.complete) return page;
    cursor = page.nextCursor;
  }
  throw new Error('fixture scan');
}
describe('bounded position deletion and GC references', () => {
  it('plans expired subjects and commits DAY position deletes without changing another subject or tenant', async () => {
    for (const pipeline of [false, true]) {
      const f = await setup(pipeline);
      const page = await plan(f);
      expect(page.deletes.map((d) => d.eventId)).toEqual(['expired']);
      expect(page.deletes[0].expiresAt).toBe(0);
      const intent = await createSnapshotDeleteIntent(page, 'a'.repeat(64));
      const mutation = await prepareSnapshotRowDelete({
        table: await f.catalog.loadTable(),
        store: f.store,
        intent,
      });
      expect(decodeSnapshotDeleteState(encodeSnapshotDeleteState(mutation))).toMatchObject({
        operationId: intent.operationId,
        snapshotId: intent.snapshotId,
      });
      const corrupted = structuredClone(mutation);
      corrupted.plan.deletes[0].pos = '999';
      await expect(
        commitSnapshotRowDelete(f.catalog, corrupted, async () => undefined)
      ).rejects.toThrow('digest');
      let once = true;
      f.catalog.afterCommit = async () => {
        if (once) {
          once = false;
          throw new IcebergCommitUnknownError('lost');
        }
      };
      await commitSnapshotRowDelete(f.catalog, mutation, async () => undefined);
      expect((await plan(f)).deletes).toEqual([]);
      const keep = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'tenant-test',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(keep.records.map((r) => r.event_id)).toEqual(['keep']);
      const foreign = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'foreign',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(foreign.records).toHaveLength(1);
      // MOR is not physical erasure: the old shared data file stays referenced.
      expect(
        await scanSnapshotArtifactReferencesPage({
          table: await f.catalog.loadTable(),
          store: f.store,
          snapshotId: intent.snapshotId,
          artifacts: [page.deletes[0].filePath],
        })
      ).toEqual({ referenced: true, complete: true });
    }
  });
  it('rewrites the shared file with delete markers applied, preserves other rows, and exposes old retained references until expiry', async () => {
    for (const pipeline of [false, true]) {
      const f = await setup(pipeline);
      const page = await plan(f);
      const source = page.deletes[0].filePath;
      const initial = String(f.catalog.metadata['current-snapshot-id']);
      const intent = await createSnapshotDeleteIntent(
        page,
        pipeline ? 'd'.repeat(64) : 'e'.repeat(64)
      );
      const mutation = await prepareSnapshotRowDelete({
        table: await f.catalog.loadTable(),
        store: f.store,
        intent,
      });
      await commitSnapshotRowDelete(f.catalog, mutation, async () => undefined);
      const lifecycle = new IcebergLifecycle({
        catalog: f.catalog,
        store: f.store,
        tableLocation: LOCATION,
      });
      await lifecycle.releaseSnapshotPin(
        'authrim-delete-' + intent.operationId,
        intent.snapshotId,
        page.tableUuid
      );
      await lifecycle.rewriteFiles([source]);
      const raw = await scanSnapshotSubjectFilesPage({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'tenant-test',
        sourceDatasets: ['pii.pii_log'],
        subjectIds: [subject],
        nowMs: 0,
      });
      expect(raw.deletes).toEqual([]);
      expect(
        await scanSnapshotArtifactReferencesPage({
          table: await f.catalog.loadTable(),
          store: f.store,
          snapshotId: initial,
          artifacts: [source],
        })
      ).toEqual({ referenced: true, complete: true });
      expect(
        await scanSnapshotArtifactReferencesPage({
          table: await f.catalog.loadTable(),
          store: f.store,
          snapshotId: String(f.catalog.metadata['current-snapshot-id']),
          artifacts: [source],
        })
      ).toEqual({ referenced: false, complete: true });
      expect(await lifecycle.expireSnapshots(Date.now() + 10_000)).toBe(2);
      const current = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'tenant-test',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(current.records.map((r) => r.event_id)).toEqual(['keep']);
      const foreign = await readSnapshotRecords({
        table: await f.catalog.loadTable(),
        store: f.store,
        tenantKey: 'foreign',
        sourceDatasets: ['pii.pii_log'],
        nowMs: 0,
      });
      expect(foreign.records).toHaveLength(1);
      // Physical GC may remove this exact old path only after all retained
      // snapshot reachability checks above, never the new shared output.
      f.store.objects.delete(source);
      expect(f.store.objects.has(source)).toBe(false);
    }
  });

  it('rejects stale compaction positions and a stale fence after accepted commit', async () => {
    const f = await setup();
    const intent = await createSnapshotDeleteIntent(await plan(f), 'b'.repeat(64));
    const mutation = await prepareSnapshotRowDelete({
      table: await f.catalog.loadTable(),
      store: f.store,
      intent,
    });
    await f.writer.appendBatch({
      batchId: 'advance',
      fence: 'fence-1',
      records: [record({ event_id: 'new' })],
    });
    await expect(
      commitSnapshotRowDelete(f.catalog, mutation, async () => undefined)
    ).rejects.toThrow('base changed');
    const next = await createSnapshotDeleteIntent(await plan(f), 'c'.repeat(64));
    const staged = await prepareSnapshotRowDelete({
      table: await f.catalog.loadTable(),
      store: f.store,
      intent: next,
    });
    let live = true;
    f.catalog.afterCommit = async () => {
      live = false;
    };
    await expect(
      commitSnapshotRowDelete(f.catalog, staged, async () => {
        if (!live) throw new Error('stale fence');
      })
    ).rejects.toThrow('stale fence');
  });
  it('requires an actual anchor path and preserves intermediate snapshots during expiration', async () => {
    const f = await setup();
    const first = (await f.catalog.loadTable()).metadata.snapshots?.[0];
    if (!first) throw new Error('Missing fixture snapshot');
    await f.writer.appendBatch({
      batchId: 'middle',
      fence: 'fence-1',
      records: [record({ event_id: 'middle' })],
    });
    await f.writer.appendBatch({
      batchId: 'last',
      fence: 'fence-1',
      records: [record({ event_id: 'last' })],
    });
    for (const name of Object.keys(f.catalog.metadata.refs ?? {}))
      if (name !== 'main') delete f.catalog.metadata.refs?.[name];
    const anchor = {
      tableUuid: f.catalog.metadata['table-uuid'],
      snapshotId: String(first['snapshot-id']),
      sequenceNumber: first['sequence-number'] ?? 0,
    };
    expect(assertIcebergSnapshotLineage(f.catalog.metadata, anchor).size).toBe(3);
    expect(
      await new IcebergLifecycle({
        catalog: f.catalog,
        store: f.store,
        tableLocation: LOCATION,
      }).expireSnapshots(Date.now() + 10_000, [anchor])
    ).toBe(0);
    const broken = structuredClone(f.catalog.metadata);
    broken.snapshots?.splice(1, 1);
    expect(() => assertIcebergSnapshotLineage(broken, anchor)).toThrow('incomplete');
    expect(() =>
      assertIcebergSnapshotLineage(f.catalog.metadata, {
        ...anchor,
        sequenceNumber: anchor.sequenceNumber + 1,
      })
    ).toThrow('sequence');
  });
});
