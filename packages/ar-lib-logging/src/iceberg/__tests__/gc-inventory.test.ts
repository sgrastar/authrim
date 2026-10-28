import { describe, expect, it } from 'vitest';
import { avroWrite } from 'icebird/avro';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { inventorySnapshotArtifactsPage, scanSnapshotArtifactReferencesPage } from '../gc-proof.js';
import { MemoryCatalog, MemoryStore, LOCATION } from './fixtures.js';

describe('bounded committed artifact ownership inventory', () => {
  it('pages all manifest/data/delete paths including deleted entries without reading a data body', async () => {
    const catalog = new MemoryCatalog(),
      store = new MemoryStore();
    const listPath = LOCATION + '/metadata/inventory-list.avro';
    const manifests = [
      LOCATION + '/metadata/inventory-0.avro',
      LOCATION + '/metadata/inventory-1.avro',
    ];
    const list = new ByteWriter();
    await avroWrite({
      writer: list,
      schema: { type: 'record', name: 'list', fields: [{ name: 'manifest_path', type: 'string' }] },
      records: manifests.map((manifest_path) => ({ manifest_path })),
    });
    await store.putImmutable(listPath, list.getBytes(), 'list');
    const expected = [listPath];
    for (let m = 0; m < 2; m++) {
      expected.push(manifests[m]);
      const writer = new ByteWriter();
      const records = Array.from({ length: m === 0 ? 40 : 35 }, (_, i) => ({
        status: i % 3,
        data_file: { file_path: LOCATION + `/data/file-${m}-${i}.parquet` },
      }));
      expected.push(...records.map((r) => r.data_file.file_path));
      await avroWrite({
        writer,
        schema: {
          type: 'record',
          name: 'manifest',
          fields: [
            { name: 'status', type: 'int' },
            {
              name: 'data_file',
              type: {
                type: 'record',
                name: 'file',
                fields: [{ name: 'file_path', type: 'string' }],
              },
            },
          ],
        },
        records,
      });
      await store.putImmutable(manifests[m], writer.getBytes(), 'manifest');
    }
    catalog.metadata['last-sequence-number'] = 1;
    catalog.metadata['current-snapshot-id'] = 1;
    catalog.metadata.snapshots = [
      {
        'snapshot-id': 1,
        'sequence-number': 1,
        'timestamp-ms': 1793000000000,
        'manifest-list': listPath,
        summary: { operation: 'append' },
      },
    ];
    let cursor;
    const found: string[] = [];
    let pages = 0;
    do {
      const page = await inventorySnapshotArtifactsPage({
        table: await catalog.loadTable(),
        store,
        snapshotId: '1',
        cursor,
      });
      expect(page.artifacts.length).toBeLessThanOrEqual(32);
      found.push(...page.artifacts);
      pages++;
      cursor = page.nextCursor;
      if (page.complete) break;
    } while (pages < 10);
    expect(pages).toBe(3);
    expect(found).toEqual(expected);
    expect(store.objects.size).toBe(3);
    const references = await scanSnapshotArtifactReferencesPage({
      table: await catalog.loadTable(),
      store,
      snapshotId: '1',
      artifacts: [
        ...manifests,
        LOCATION + '/data/file-0-0.parquet',
        LOCATION + '/data/file-0-2.parquet',
      ],
      includeReferencedArtifacts: true,
    });
    expect(references.complete).toBe(true);
    expect(new Set(references.referencedArtifacts)).toEqual(
      new Set([...manifests, LOCATION + '/data/file-0-0.parquet'])
    );

    await expect(
      inventorySnapshotArtifactsPage({
        table: await catalog.loadTable(),
        store,
        snapshotId: '1',
        cursor: {
          version: 1,
          tableUuid: catalog.metadata['table-uuid'],
          snapshotId: '1',
          physicalFingerprint: 'x',
          manifest: 0,
          entry: -3,
          listed: true,
        },
      })
    ).rejects.toThrow('cursor');
  });
});
