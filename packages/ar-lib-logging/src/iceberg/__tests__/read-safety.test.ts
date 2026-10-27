import { describe, expect, it, vi } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import { readDataFile } from 'icebird/src/read.js';
import { parquetHeader } from 'hyparquet/src/column.js';
import { safeParquetFooter, safeParquetPages, safeZstd } from '../read-safety.js';
import { safeReadResolver } from '../read-buffer.js';
import { ScheduledIcebergWriter, LOG_ARCHIVE_PENDING_PIN_TTL_MS } from '../writer.js';
import { IcebergLifecycle } from '../lifecycle.js';
import { IcebergBudgetError, IcebergCommitUnknownError } from '../types.js';
import { LOCATION, MemoryCatalog, MemoryJournal, MemoryStore, record } from './fixtures.js';

const ZSTD_PARQUET =
  'UEFSMRUEFSQVNkwVAhUAEgAAKLUv/SASkQAADgAAAHJlcGVhdGVkLXZhbHVlFQAVEhUkLBUYFRAVBhUGHDYAKA5yZXBlYXRlZC12YWx1ZRgOcmVwZWF0ZWQtdmFsdWUREQAAACi1L/0gCUkAAAIAAAAYAQEYABUEGSw1ABgGc2NoZW1hFQIAFQwlAhgGc2FtcGxlJQBMHAAAABYYGRwZHCYAHBUMGTUABhAZGAZzYW1wbGUVDBYYFsABFuQBJlomCBw2ACgOcmVwZWF0ZWQtdmFsdWUYDnJlcGVhdGVkLXZhbHVlEREAGSwVBBUAFQIAFQAVEBUCADwW0AIZBhkmABgAAAAWwAEWGCYIFuQBABkcGAxBUlJPVzpzY2hlbWEYoAEvLy8vLzNBQUFBQVFBQUFBQUFBS0FBd0FCZ0FGQUFnQUNnQUFBQUFCQkFBTUFBQUFDQUFJQUFBQUJBQUlBQUFBQkFBQUFBRUFBQUFVQUFBQUVBQVVBQWdBQmdBSEFBd0FBQUFRQUJBQUFBQUFBQUVGRUFBQUFCd0FBQUFFQUFBQUFBQUFBQVlBQUFCellXMXdiR1VBQUFRQUJBQUVBQUFBABggcGFycXVldC1jcHAtYXJyb3cgdmVyc2lvbiAyNi4wLjAZHBwAAAB1AQAAUEFSMQ==';
const zstdBytes = () => Uint8Array.from(atob(ZSTD_PARQUET), (char) => char.charCodeAt(0));

describe('binary read allocation guards', () => {
  it('rejects oversized page allocations and rowgroups before decoding', () => {
    const writer = new ByteWriter();
    serializeTCompactProtocol(writer, {
      field_1: 0,
      field_2: 1_000_000_000,
      field_3: 1,
      field_5: { field_1: 1, field_2: 0, field_3: 3, field_4: 3 },
    });
    writer.appendUint8(0);
    expect(() => safeParquetPages(writer.getBytes(), 1000, 8 * 1024 * 1024, 'SNAPPY')).toThrow(
      IcebergBudgetError
    );
    const bytes = zstdBytes();
    const footer = safeParquetFooter(bytes);
    expect(Number(footer.row_groups[0].num_rows)).toBe(12);
  });
  it('rejects malicious dictionary RLE runs before upstream expands its JS array', () => {
    const dictionary = new ByteWriter();
    serializeTCompactProtocol(dictionary, {
      field_1: 2,
      field_2: 4,
      field_3: 4,
      field_7: { field_1: 1, field_2: 0 },
    });
    dictionary.appendInt32(0);
    const payload = new ByteWriter();
    payload.appendUint8(1);
    payload.appendVarInt(100_000_000 * 2);
    payload.appendUint8(0);
    serializeTCompactProtocol(dictionary, {
      field_1: 0,
      field_2: payload.offset,
      field_3: payload.offset,
      field_5: { field_1: 1, field_2: 8, field_3: 3, field_4: 3 },
    });
    dictionary.appendBytes(payload.getBytes());
    expect(() =>
      safeParquetPages(dictionary.getBytes(), 1000, 4096, 'UNCOMPRESSED', {
        type: 'INT32',
        optional: false,
      })
    ).toThrow('RLE run');
  });

  it('validates independent PyArrow ZSTD frames, including bounded output/window', () => {
    const bytes = zstdBytes();
    const footer = safeParquetFooter(bytes);
    const column = footer.row_groups[0].columns[0].meta_data;
    if (!column) throw new Error('fixture column missing');
    const offset = Number(column.dictionary_page_offset ?? column.data_page_offset);
    const chunk = bytes.subarray(offset, offset + Number(column.total_compressed_size));
    expect(safeParquetPages(chunk, 12, 4096, 'ZSTD')).toBeGreaterThan(0);
    const reader = {
      view: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      offset: 0,
    };
    const page = parquetHeader(reader);
    const encoded = chunk.subarray(reader.offset, reader.offset + page.compressed_page_size);
    expect(() => safeZstd(encoded, page.uncompressed_page_size)).not.toThrow();
    expect(() => safeZstd(encoded, 1)).toThrow(IcebergBudgetError);
  });
  it('decodes the independently produced ZSTD fixture through the guarded upstream data reader', async () => {
    for (const unknown of [false, true]) {
      const bytes = zstdBytes();
      if (unknown) {
        const column = safeParquetFooter(bytes).row_groups[0].columns[0].meta_data;
        if (!column) throw new Error('fixture');
        let offset = Number(column.dictionary_page_offset ?? column.data_page_offset);
        const end = offset + Number(column.total_compressed_size);
        while (offset < end) {
          const reader = { view: new DataView(bytes.buffer), offset };
          const page = parquetHeader(reader);
          bytes[reader.offset + 4] = 0;
          bytes[reader.offset + 5] = 0; // no FCS, bounded 1KiB window
          offset = reader.offset + page.compressed_page_size;
        }
      }
      const store = new MemoryStore();
      store.objects.set('zstd.parquet', { bytes, identity: 'fixture' });
      const resolver = safeReadResolver({
        store,
        maxFiles: 2,
        maxBytes: 1024 * 1024,
        maxFileBytes: 1024 * 1024,
        maxRows: 100,
        deadline: Date.now() + 1000,
        filters: new Map(),
      });
      const schema = {
        type: 'struct' as const,
        'schema-id': 0,
        fields: [{ id: 1, name: 'sample', type: 'string' as const, required: false }],
      };
      const table = new MemoryCatalog().metadata;
      table.schemas = [schema];
      table['last-column-id'] = 1;
      const output: unknown[] = [];
      for await (const batch of readDataFile({
        metadata: table,
        schema,
        resolver,
        rowLineage: false,
        fileRowStart: 0,
        fileRowEnd: 12,
        dataEntry: {
          status: 1,
          snapshot_id: 1n,
          sequence_number: 1n,
          file_sequence_number: 1n,
          data_file: {
            content: 0,
            file_path: 'zstd.parquet',
            file_format: 'parquet',
            partition: {},
            record_count: 12n,
            file_size_in_bytes: BigInt(bytes.byteLength),
          },
        },
      }))
        output.push(...(batch as unknown[]));
      expect(output).toHaveLength(12);
      expect(output[0]).toEqual({ sample: 'repeated-value' });
    }
  });

  it('serializes concurrent manifest reads before reserving the shared byte budget', async () => {
    const catalog = new MemoryCatalog();
    const store = new MemoryStore();
    const journal = new MemoryJournal();
    await new ScheduledIcebergWriter({
      catalog,
      store,
      journal,
      storageGeneration: 'new-generation',
      tableLocation: LOCATION,
    }).appendBatch({ batchId: 'seed', fence: 'fence-1', records: [record()] });
    const avro = [...store.objects].find(([path]) => path.endsWith('-m0.avro'))?.[1].bytes;
    if (!avro) throw new Error('manifest fixture missing');
    let active = 0;
    let peak = 0;
    let acceptedBytes = 0;
    const read = vi.fn(async (_path: string, limit: number) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (avro.byteLength > limit) throw new IcebergBudgetError('preallocation limit');
        acceptedBytes += avro.byteLength;
        return Uint8Array.from(avro);
      } finally {
        active--;
      }
    });
    const resolver = safeReadResolver({
      store: { read, putImmutable: async () => undefined },
      maxFiles: 64,
      maxBytes: avro.byteLength * 2 + 1,
      maxFileBytes: 1024 * 1024,
      maxRows: 1000,
      deadline: Date.now() + 1000,
      filters: new Map(),
    });
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, (_, i) => resolver.reader(`manifest-${i}.avro`))
    );
    expect(peak).toBe(1);
    expect(acceptedBytes).toBe(avro.byteLength * 2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
  it('uses bounded ranges even when the Parquet object is 64 MiB', async () => {
    const original = zstdBytes();
    const footerLength = new DataView(original.buffer).getUint32(original.byteLength - 8, true) + 8;
    const body = original.subarray(0, original.byteLength - footerLength);
    const footer = original.subarray(original.byteLength - footerLength);
    const size = 64 * 1024 * 1024;
    let transferred = 0;
    const readRange = vi.fn(async (_path: string, offset: number, length: number) => {
      transferred += length;
      const out = new Uint8Array(length);
      for (const [start, data] of [
        [0, body],
        [size - footerLength, footer],
      ] as const) {
        const low = Math.max(offset, start);
        const high = Math.min(offset + length, start + data.byteLength);
        if (low < high) out.set(data.subarray(low - start, high - start), low - offset);
      }
      return out;
    });
    const resolver = safeReadResolver({
      store: {
        read: async () => {
          throw new Error('full read forbidden');
        },
        size: async () => size,
        readRange,
        putImmutable: async () => undefined,
      },
      maxFiles: 2,
      maxBytes: 1024 * 1024,
      maxFileBytes: 1024 * 1024,
      maxRows: 100,
      deadline: Date.now() + 1000,
      filters: new Map(),
    });
    const file = await resolver.reader('compacted.parquet');
    expect(file.byteLength).toBe(size);
    expect(transferred).toBeLessThan(1024 * 1024);
    expect(readRange).toHaveBeenCalled();
  });
});

it('does not extend a pending pin lease on resume and gives old DR snapshots a fresh clone lease', async () => {
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
  const receipt = await writer.appendBatch({
    batchId: 'lease',
    fence: 'fence-1',
    records: [record()],
  });
  const lifecycle = new IcebergLifecycle({ catalog, store, tableLocation: LOCATION });
  const source = catalog.metadata.snapshots?.find(
    (s) => String(s['snapshot-id']) === receipt.snapshotId
  );
  if (!source) throw new Error('snapshot fixture missing');
  source['timestamp-ms'] = Date.now() - 60 * 24 * 3600 * 1000;
  const captured = await lifecycle.pinSnapshot('dr-old-source', receipt.snapshotId, 60_000);
  const pin = captured.metadata.refs?.['dr-old-source'];
  expect(String(pin?.['snapshot-id'])).not.toBe(receipt.snapshotId);
  const cloned = captured.metadata.snapshots?.find(
    (s) => String(s['snapshot-id']) === String(pin?.['snapshot-id'])
  );
  expect((cloned?.['timestamp-ms'] ?? 0) + (pin?.['max-ref-age-ms'] ?? 0)).toBeGreaterThan(
    Date.now()
  );
  const now = vi.spyOn(Date, 'now').mockReturnValue(receipt.pinExpiresAt + 1);
  try {
    await expect(
      writer.appendBatch({ batchId: 'lease', fence: 'fence-1', records: [record()] })
    ).rejects.toBeInstanceOf(IcebergCommitUnknownError);
  } finally {
    now.mockRestore();
  }
  expect(receipt.pinExpiresAt - (journal.entries.get('lease')?.createdAt ?? 0)).toBe(
    LOG_ARCHIVE_PENDING_PIN_TTL_MS
  );
});
