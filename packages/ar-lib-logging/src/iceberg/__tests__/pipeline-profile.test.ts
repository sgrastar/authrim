import { describe, expect, it } from 'vitest';
import { icebergManifests, splitManifestEntries } from 'icebird/src/manifest.js';
import {
  inspectLogArchiveTable,
  logArchivePhysicalFingerprint,
  assertLogArchivePhysicalFingerprint,
  assertLogArchiveTableLocations,
} from '../physical-schema.js';
import { ScheduledIcebergWriter } from '../writer.js';
import { readSnapshotRecords } from '../reader.js';
import { IcebergLifecycle } from '../lifecycle.js';
import {
  LOCATION,
  pipelineMetadata,
  MemoryCatalog,
  MemoryJournal,
  MemoryStore,
  record,
} from './fixtures.js';

function fixture(first: boolean) {
  const catalog = new MemoryCatalog();
  catalog.metadata = pipelineMetadata(first);
  const store = new MemoryStore();
  const journal = new MemoryJournal();
  const writer = new ScheduledIcebergWriter({
    catalog,
    store,
    journal,
    storageGeneration: 'new-generation',
    tableLocation: LOCATION,
  });
  const lifecycle = new IcebergLifecycle({ catalog, store, tableLocation: LOCATION });
  const read = async () =>
    readSnapshotRecords({
      table: await catalog.loadTable(),
      store,
      tenantKey: 'tenant-test',
      sourceDatasets: ['core.event_log'],
      nowMs: 1793000005000,
    });
  return { catalog, store, writer, lifecycle, read };
}

describe('new Pipeline physical profile', () => {
  it('accepts only the provider timestamp/day shape and pins actual IDs in its fingerprint', async () => {
    for (const first of [false, true])
      for (const type of ['timestamp', 'timestamptz'] as const) {
        const table = pipelineMetadata(first, type);
        const profile = inspectLogArchiveTable(table, 'pipeline');
        expect(profile.mode).toBe('pipeline');
        expect(profile.fieldIds.tenant_key).toBe(first ? 5 : 4);
        expect(profile.providerField?.id).toBe(first ? 1 : 21);
        await expect(
          assertLogArchivePhysicalFingerprint(table, await logArchivePhysicalFingerprint(table))
        ).resolves.toMatchObject({ mode: 'pipeline' });
        expect(() => inspectLogArchiveTable(table, 'scheduled')).toThrow('mode');
      }
    const first = pipelineMetadata(true);
    const end = pipelineMetadata(false);
    expect(await logArchivePhysicalFingerprint(first)).not.toBe(
      await logArchivePhysicalFingerprint(end)
    );
    first['partition-specs'][0].fields[0].transform = 'hour';
    expect(() => inspectLogArchiveTable(first)).toThrow('DAY');
    const extra = pipelineMetadata();
    extra.schemas[0].fields.push({
      id: 22,
      name: 'other_provider_column',
      type: 'string',
      required: false,
    });
    expect(() => inspectLogArchiveTable(extra)).toThrow('columns');
  });

  it('rejects cross-bucket or cross-table catalog object locations', () => {
    const table = {
      metadata: pipelineMetadata(),
      metadataLocation: LOCATION + '/metadata/current.metadata.json',
    };
    expect(() => assertLogArchiveTableLocations(table, 'authrim-test')).not.toThrow();
    expect(() => assertLogArchiveTableLocations(table, 'foreign-bucket')).toThrow('bucket');
    expect(() =>
      assertLogArchiveTableLocations(
        { ...table, metadataLocation: 's3://authrim-test/another-table/metadata/current.json' },
        'authrim-test'
      )
    ).toThrow('table');
  });

  it('writes day-partitioned files, applies position deletes and restores across provider ID placement', async () => {
    const f = fixture(true);
    const keep = record({ event_id: 'keep', ingested_at: 1793000001000 });
    const expired = record({
      event_id: 'expired',
      ingested_at: 1793000001000 + 86400000,
      expires_at: 1793000005000,
    });
    const receipt = await f.writer.appendBatch({
      batchId: 'partitioned',
      fence: 'fence-1',
      records: [keep, expired],
    });
    const rawResolver = {
      reader: async (path: string) => {
        const bytes = await f.store.read(path, 1024 * 1024);
        return {
          byteLength: bytes.byteLength,
          slice: (start: number, end?: number) =>
            Uint8Array.from(bytes.subarray(start, end)).buffer,
        };
      },
    };
    const groups = await icebergManifests({ metadata: f.catalog.metadata, resolver: rawResolver });
    const files = splitManifestEntries(groups).dataEntries;
    expect(files).toHaveLength(2);
    expect(
      new Set(files.map((entry) => String(entry.data_file.partition.__ingest_ts_day))).size
    ).toBe(2);
    const found = await f.read();
    expect(found.records).toEqual([keep]);
    expect(found.records[0]).not.toHaveProperty('__ingest_ts');
    const captured = await f.lifecycle.pinSnapshot('dr-pipeline', receipt.snapshotId);
    expect(
      await f.lifecycle.deleteExpiredRows({
        tenantKey: 'tenant-test',
        sourceDatasets: ['core.event_log'],
        nowMs: 1793000005000,
      })
    ).toBe(1);
    expect((await f.read()).records).toEqual([keep]);
    const target = fixture(false);
    await target.writer.appendBatch({
      batchId: 'restore',
      fence: 'fence-1',
      records: found.records,
    });
    expect((await target.read()).records).toEqual([keep]);
    expect(captured.metadata.refs?.['dr-pipeline']?.type).toBe('tag');
  });
});
