import { beforeAll, describe, expect, it } from 'vitest';
import { writeParquet } from 'icebird/src/write/parquet.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { readFlatFileWindow } from '../flat-reader.js';
import { inspectLogArchiveTable } from '../physical-schema.js';
import { safeReadResolver } from '../read-buffer.js';
import { IcebergBudgetError } from '../types.js';
import { MemoryStore, metadata, record } from './fixtures.js';

describe('flat Parquet window boundaries', () => {
  let archive: Awaited<ReturnType<ReturnType<typeof safeReadResolver>['openParquet']>>;
  let profile: ReturnType<typeof inspectLogArchiveTable>;

  beforeAll(async () => {
    const table = metadata();
    const output = new ByteWriter();
    const records = Array.from({ length: 8 }, (_, index) => ({
      ...record({ event_id: `event-${index}`, tenant_key: index < 4 ? 'tenant-a' : 'tenant-b' }),
      event_at: 1793000000000n,
      ingested_at: 1793000001000n,
      expires_at: null,
    }));
    await writeParquet({ writer: output, schema: table.schemas[0], records, codec: 'SNAPPY' });
    const store = new MemoryStore();
    store.objects.set('events.parquet', {
      bytes: Uint8Array.from(output.getBytes()),
      identity: 'fixture',
    });
    archive = await safeReadResolver({
      store,
      maxFiles: 2,
      maxBytes: 4 * 1024 * 1024,
      maxFileBytes: 2 * 1024 * 1024,
      maxRows: 100,
      deadline: Date.now() + 30_000,
      filters: new Map(),
    }).openParquet('events.parquet');
    profile = inspectLogArchiveTable(table);
  });

  function withoutPhysicalField(name: keyof typeof profile.fieldIds) {
    const file = { ...archive, metadata: structuredClone(archive.metadata) };
    const index = file.metadata.schema.findIndex(
      (element) => element.field_id === profile.fieldIds[name]
    );
    if (index < 0) throw new Error(`Fixture field ${name} is missing`);
    const physicalName = file.metadata.schema[index].name;
    file.metadata.schema.splice(index, 1);
    file.metadata.schema[0].num_children = Number(file.metadata.schema[0].num_children) - 1;
    for (const group of file.metadata.row_groups) {
      const column = group.columns.findIndex(
        (item) => item.meta_data?.path_in_schema.join('.') === physicalName
      );
      if (column >= 0) group.columns.splice(column, 1);
    }
    return file;
  }

  it('rejects an oversized row window before reading any page', async () => {
    await expect(
      readFlatFileWindow({ file: archive, profile, rowStart: 0, rowEnd: 10_001 })
    ).rejects.toThrow(IcebergBudgetError);
  });

  it('rejects an archive missing a required physical field', async () => {
    await expect(
      readFlatFileWindow({
        file: withoutPhysicalField('tenant_key'),
        profile,
        rowStart: 0,
        rowEnd: 2,
      })
    ).rejects.toThrow('Required archive physical field is missing');
  });

  it('rejects a physical field whose primitive type differs from the table contract', async () => {
    const file = { ...archive, metadata: structuredClone(archive.metadata) };
    const physical = file.metadata.schema.find(
      (element) => element.field_id === profile.fieldIds.event_id
    );
    if (!physical) throw new Error('Fixture event ID field is missing');
    physical.type = 'INT32';

    await expect(readFlatFileWindow({ file, profile, rowStart: 0, rowEnd: 2 })).rejects.toThrow(
      'Unsupported flat physical column type'
    );
  });

  it('returns null for a missing optional field without exposing other columns', async () => {
    const result = await readFlatFileWindow({
      file: withoutPhysicalField('severity'),
      profile,
      rowStart: 0,
      rowEnd: 2,
      projection: ['severity'],
    });

    expect(result.rows).toEqual([
      { position: 0n, values: { severity: null } },
      { position: 1n, values: { severity: null } },
    ]);
  });

  it('stops selected-row scanning at the requested match limit', async () => {
    const result = await readFlatFileWindow({
      file: archive,
      profile,
      rowStart: 0,
      rowEnd: 8,
      select: {
        field: 'event_id',
        matches: (value) => {
          const eventId = value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
          return eventId === 'event-2' || eventId === 'event-4' || eventId === 'event-6';
        },
        maxMatches: 2,
      },
    });

    expect(result.rows.map((row) => row.position)).toEqual([2n, 4n]);
    expect(result.nextRow).toBe(5);
  });

  it('rejects a continuation cursor that points before the column data', async () => {
    await expect(
      readFlatFileWindow({
        file: archive,
        profile,
        rowStart: 2,
        rowEnd: 4,
        projection: ['event_id'],
        columns: [
          { fieldId: profile.fieldIds.event_id, groupIndex: 0, byteOffset: 0, firstRow: 0 },
        ],
      })
    ).rejects.toThrow('Invalid flat column cursor');
  });
});
