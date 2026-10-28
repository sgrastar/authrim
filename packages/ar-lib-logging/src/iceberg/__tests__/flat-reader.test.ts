import { describe, expect, it } from 'vitest';
import { writeParquet } from 'icebird/src/write/parquet.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import { inspectLogArchiveTable } from '../physical-schema.js';
import { safeReadResolver } from '../read-buffer.js';
import { readFlatFileWindow } from '../flat-reader.js';
import { decodeFlatPage } from '../flat-page.js';
import { safeParquetPages } from '../read-safety.js';
import { metadata, MemoryStore, record } from './fixtures.js';

describe('selected flat Parquet values', () => {
  it('keeps only a selected row when a valid tiny dictionary page represents 100 million rows', () => {
    const page = new ByteWriter();
    serializeTCompactProtocol(page, {
      field_1: 0,
      field_2: 1,
      field_3: 1,
      field_5: { field_1: 100_000_000, field_2: 8, field_3: 3, field_4: 3 },
    });
    page.appendUint8(0); // one dictionary entry, bit width zero
    expect(
      safeParquetPages(page.getBytes(), 100_000_000, 1024, 'UNCOMPRESSED', {
        type: 'BYTE_ARRAY',
        optional: false,
        dictionaryValues: 1,
      })
    ).toBe(1);
    let retained = 0;
    const found = decodeFlatPage({
      page: page.getBytes(),
      codec: 'UNCOMPRESSED',
      column: { type: 'BYTE_ARRAY', optional: false },
      rowStart: 99_999_999,
      rowEnd: 100_000_000,
      dictionary: ['constant'],
      reserve: (bytes) => {
        retained += bytes;
      },
    });
    expect(found.values).toEqual(['constant']);
    expect(retained).toBe(32);
  });

  it('reads a tiny window from a large mixed-tenant rowgroup with exact field IDs', async () => {
    const table = metadata();
    const store = new MemoryStore();
    const output = new ByteWriter();
    const records = Array.from({ length: 20_000 }, (_, index) => ({
      ...record({
        event_id: `event-${index}`,
        tenant_key: index < 10_000 ? 'other' : 'tenant-test',
      }),
      event_at: 1793000000000n,
      ingested_at: 1793000001000n,
      expires_at: null,
    }));
    await writeParquet({ writer: output, schema: table.schemas[0], records, codec: 'SNAPPY' });
    const bytes = Uint8Array.from(output.getBytes());
    store.objects.set('large.parquet', { bytes, identity: 'fixture' });
    const resolver = safeReadResolver({
      store,
      maxFiles: 8,
      maxBytes: 32 * 1024 * 1024,
      maxFileBytes: 8 * 1024 * 1024,
      maxRows: 5,
      deadline: Date.now() + 10_000,
      filters: new Map(),
    });
    const file = await resolver.openParquet('large.parquet');
    expect(file.metadata.row_groups.some((group) => Number(group.num_rows) > 10_000)).toBe(true);
    const result = await readFlatFileWindow({
      file,
      profile: inspectLogArchiveTable(table),
      rowStart: 19_995,
      rowEnd: 20_000,
      filter: { tenant_key: { $eq: 'tenant-test' } },
    });
    expect(result.rows).toHaveLength(5);
    expect(result.rows[0].position).toBe(19_995n);
    expect(result.rows[0].values).toEqual(records[19_995]);
  });
});
