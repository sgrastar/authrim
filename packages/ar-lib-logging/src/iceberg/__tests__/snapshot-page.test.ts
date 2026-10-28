import { describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { prepareAppend, stageSnapshotForAppend } from 'icebird/src/write/stage.js';
import {
  readSnapshotPage,
  readSnapshotRecords,
  verifySnapshotBatch,
  type SnapshotScanCursor,
} from '../reader.js';
import { ScheduledIcebergWriter } from '../writer.js';
import { MemoryCatalog, MemoryJournal, MemoryStore, record, LOCATION } from './fixtures.js';

async function compacted() {
  const catalog = new MemoryCatalog();
  const store = new MemoryStore();
  const records = Array.from({ length: 25_000 }, (_, i) => ({
    ...record({
      event_id: `event-${i.toString().padStart(6, '0')}`,
      tenant_key: i < 24_800 ? 'other' : 'tenant-test',
    }),
    event_at: 1793000000000n,
    ingested_at: 1793000001000n,
    expires_at: null,
  }));
  const resolver = {
    writer: (path: string) => {
      const writer = new ByteWriter();
      return Object.assign(writer, {
        finish: async () => store.putImmutable(path, writer.getBytes(), path),
      });
    },
  };
  const prepared = await prepareAppend({
    tableUrl: LOCATION,
    metadata: catalog.metadata,
    records,
    resolver,
  });
  const staged = await stageSnapshotForAppend({
    tableUrl: LOCATION,
    metadata: catalog.metadata,
    prepared,
    resolver,
  });
  await catalog.commit(staged);
  return { catalog, store };
}

describe('fixed snapshot pages and exact source proof', () => {
  it('selects an exact late event from a compacted mixed-tenant file without expanding its rowgroup', async () => {
    const f = await compacted();
    const result = await readSnapshotRecords({
      table: await f.catalog.loadTable(),
      store: f.store,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: 1793000005000,
      eventIds: ['event-024999'],
      limits: { maxRows: 2 },
    });
    expect(result.records.map((row) => row.event_id)).toEqual(['event-024999']);
  });
  it('continues a fixed snapshot and rejects query or physical-scope cursor changes', async () => {
    const f = await compacted();
    const options = {
      table: await f.catalog.loadTable(),
      store: f.store,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: 1793000005000,
      pageSize: 64,
    };
    const rows: string[] = [];
    let cursor: SnapshotScanCursor | undefined;
    for (let i = 0; i < 10; i++) {
      const page = await readSnapshotPage({ ...options, cursor });
      rows.push(...page.records.map((row) => row.event_id));
      if (page.complete) break;
      cursor = page.nextCursor;
    }
    expect(rows).toHaveLength(200);
    expect(new Set(rows).size).toBe(200);
    const first = await readSnapshotPage(options);
    if (!first.nextCursor) throw new Error('Missing fixture continuation');
    await expect(
      readSnapshotPage({ ...options, tenantKey: 'other', cursor: first.nextCursor })
    ).rejects.toThrow('cursor');
    await expect(
      readSnapshotPage({ ...options, cursor: { ...first.nextCursor, physicalFingerprint: 'bad' } })
    ).rejects.toThrow('cursor');
  });
  it('uses metadata continuations beyond 128 batches instead of opening every manifest at once', async () => {
    const catalog = new MemoryCatalog();
    const store = new MemoryStore();
    const writer = new ScheduledIcebergWriter({
      catalog,
      store,
      journal: new MemoryJournal(),
      storageGeneration: 'new-generation',
      tableLocation: LOCATION,
    });
    for (let i = 0; i < 140; i++)
      await writer.appendBatch({
        batchId: `batch-${i}`,
        fence: 'fence-1',
        records: [record({ event_id: `event-${i}` })],
      });
    const options = {
      table: await catalog.loadTable(),
      store,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: 1793000005000,
      eventIds: ['event-139'],
    };
    let cursor: SnapshotScanCursor | undefined;
    const found: string[] = [];
    let pages = 0;
    do {
      const page = await readSnapshotPage({ ...options, cursor });
      pages++;
      found.push(...page.records.map((row) => row.event_id));
      cursor = page.nextCursor;
      if (page.complete) break;
    } while (pages < 12);
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(12);
    expect(found).toEqual(['event-139']);
  });

  it('verifies expiry zero and rejects a changed envelope at the exact receipt snapshot', async () => {
    const catalog = new MemoryCatalog();
    const store = new MemoryStore();
    const journal = new MemoryJournal();
    const writer = new ScheduledIcebergWriter({
      catalog,
      store,
      journal,
      storageGeneration: 'new-generation',
      tableLocation: LOCATION,
    });
    const expired = record({ expires_at: 0 });
    const receipt = await writer.appendBatch({
      batchId: 'expiry-zero',
      fence: 'fence-1',
      records: [expired],
    });
    const options = {
      table: await catalog.loadTable(),
      store,
      snapshotId: receipt.snapshotId,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: Date.now(),
      expectedRecords: [expired],
    };
    expect((await verifySnapshotBatch(options)).snapshotId).toBe(receipt.snapshotId);
    await expect(
      verifySnapshotBatch({
        ...options,
        expectedRecords: [{ ...expired, detail_ciphertext: 'different' }],
      })
    ).rejects.toThrow('differs');
    expect((await readSnapshotRecords(options)).records).toEqual([]);
  });
});
