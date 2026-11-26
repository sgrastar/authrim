import { describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import { safeParquetFooter, safeParquetHeader, safeParquetIndex } from '../read-safety.js';
import { IcebergBudgetError } from '../types.js';
import { readerFixture } from './reader-mutation-harness.js';
import { record } from './fixtures.js';
import { text, varint, bytesOf } from './binary-builders.js';

const STOP = 0;
const field = (delta: number, type: number): number => (delta << 4) | type;

describe('safeParquetIndex: compact Thrift structure', () => {
  it('reads an empty struct as no elements', () => {
    expect(safeParquetIndex(Uint8Array.from([STOP]))).toBe(0);
  });

  it('counts one element per field, whatever its type', () => {
    expect(safeParquetIndex(Uint8Array.from([field(1, 5), 2, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 1), field(1, 2), STOP]))).toBe(2);
    expect(safeParquetIndex(Uint8Array.from([field(1, 3), 7, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 4), 0x80, 0x01, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 6), 0xff, 0x7f, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 7), 1, 2, 3, 4, 5, 6, 7, 8, STOP]))).toBe(1);
  });

  it('reads multi-byte varints and the field id written out when the delta is zero', () => {
    expect(safeParquetIndex(Uint8Array.from([field(0, 5), 2, 0x80, 0x01, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(0, 5), 0x80, 0x01, 4, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 5), ...bytesOf(9, 0x80), 0x01, STOP]))).toBe(
      1
    );
  });

  it('refuses a varint of more than ten bytes', () => {
    const eleven = [field(1, 5), ...bytesOf(10, 0x80), 0x01, STOP];
    expect(() => safeParquetIndex(Uint8Array.from(eleven))).toThrow('Invalid binary varint');
  });

  it('refuses structures that end early', () => {
    expect(() => safeParquetIndex(Uint8Array.from([]))).toThrow('Invalid bounded binary length');
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 5)]))).toThrow(
      'Invalid bounded binary length'
    );
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 3)]))).toThrow(
      'Invalid bounded binary length'
    );
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 7), 1, 2, 3]))).toThrow(
      'Invalid bounded binary length'
    );
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 5), 2]))).toThrow(
      'Invalid bounded binary length'
    );
    expect(() => safeParquetIndex(Uint8Array.from([field(0, 5)]))).toThrow(
      'Invalid bounded binary length'
    );
  });

  it('refuses bytes after the struct', () => {
    expect(() => safeParquetIndex(Uint8Array.from([STOP, STOP]))).toThrow(
      'Parquet index trailing bytes'
    );
  });

  it('reads strings within the bytes that remain', () => {
    expect(safeParquetIndex(Uint8Array.from([field(1, 8), 3, 97, 98, 99, STOP]))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from([field(1, 8), 0, STOP]))).toBe(1);
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 8), 9, 97, STOP]))).toThrow(
      'Parquet metadata string budget exceeded'
    );
    const huge = Uint8Array.from([field(1, 8), ...varint(2 ** 40), STOP]);
    expect(() => safeParquetIndex(huge)).toThrow('Parquet metadata string budget exceeded');
    expect(() => safeParquetIndex(Uint8Array.from([field(1, 8), 5, 97, 98, STOP]))).toThrow(
      'Invalid bounded binary length'
    );
  });

  it('reads lists by their element type, counting their elements', () => {
    const ints = [field(1, 9), (3 << 4) | 5, 2, 4, 6, STOP];
    expect(safeParquetIndex(Uint8Array.from(ints))).toBe(1 + 3);
    const bools = [field(1, 9), (3 << 4) | 1, 1, 2, 1, STOP];
    expect(safeParquetIndex(Uint8Array.from(bools))).toBe(1 + 3);
    const bytes = [field(1, 9), (2 << 4) | 3, 1, 2, STOP];
    expect(safeParquetIndex(Uint8Array.from(bytes))).toBe(1 + 2);
    const longList = [field(1, 9), (15 << 4) | 5, ...varint(16), ...bytesOf(16, 2), STOP];
    expect(safeParquetIndex(Uint8Array.from(longList))).toBe(1 + 16);
    const empty = [field(1, 9), (0 << 4) | 5, STOP];
    expect(safeParquetIndex(Uint8Array.from(empty))).toBe(1);
    const structs = [field(1, 9), (2 << 4) | 12, field(1, 5), 2, STOP, field(1, 5), 2, STOP, STOP];
    expect(safeParquetIndex(Uint8Array.from(structs))).toBe(1 + 2 + 2);
    const strings = [field(1, 9), (2 << 4) | 8, 1, 97, 2, 98, 99, STOP];
    expect(safeParquetIndex(Uint8Array.from(strings))).toBe(1 + 2);
    const doubles = [field(1, 9), (1 << 4) | 7, 1, 2, 3, 4, 5, 6, 7, 8, STOP];
    expect(safeParquetIndex(Uint8Array.from(doubles))).toBe(2);
    const nested = [field(1, 9), (1 << 4) | 9, (2 << 4) | 5, 2, 4, STOP];
    expect(safeParquetIndex(Uint8Array.from(nested))).toBe(1 + 1 + 2);
  });

  it('refuses a list longer than the bytes or the budget that remain', () => {
    const longer = [field(1, 9), (5 << 4) | 5, 2, 4, STOP];
    expect(() => safeParquetIndex(Uint8Array.from(longer))).toThrow(
      'Parquet metadata list budget exceeded'
    );
    const exact = [field(1, 9), (2 << 4) | 5, 2, 4, STOP];
    expect(safeParquetIndex(Uint8Array.from(exact))).toBe(3);
    const huge = [field(1, 9), (15 << 4) | 5, ...varint(2 ** 40), STOP];
    expect(() => safeParquetIndex(Uint8Array.from(huge))).toThrow(
      'Parquet metadata list budget exceeded'
    );
    const overBudget = [field(1, 9), (15 << 4) | 3, ...varint(25_000), ...bytesOf(25_000, 1), STOP];
    expect(() => safeParquetIndex(Uint8Array.from(overBudget))).toThrow(
      'Parquet metadata list budget exceeded'
    );
  });

  it('refuses types it cannot bound', () => {
    for (const type of [10, 11, 13, 14, 15]) {
      expect(() => safeParquetIndex(Uint8Array.from([field(1, type), 0, STOP]))).toThrow(
        'Unsupported bounded Parquet metadata type'
      );
    }
    const inList = [field(1, 9), (1 << 4) | 11, 0, STOP];
    expect(() => safeParquetIndex(Uint8Array.from(inList))).toThrow(
      'Unsupported bounded Parquet metadata type'
    );
  });

  it('follows nested structs and refuses nesting deeper than sixteen', () => {
    const nested = (levels: number): number[] => {
      let bytes: number[] = [STOP];
      for (let i = 0; i < levels; i += 1) bytes = [field(1, 12), ...bytes, STOP];
      return bytes;
    };
    expect(safeParquetIndex(Uint8Array.from(nested(1)))).toBe(1);
    expect(safeParquetIndex(Uint8Array.from(nested(16)))).toBe(16);
    expect(() => safeParquetIndex(Uint8Array.from(nested(17)))).toThrow(
      'Parquet metadata nesting exceeded'
    );
    const inList = [field(1, 9), (1 << 4) | 12, field(1, 12), STOP, STOP, STOP];
    expect(safeParquetIndex(Uint8Array.from(inList))).toBe(3);
  });

  it('bounds the elements of a struct at twenty thousand', () => {
    const fields = (count: number): Uint8Array =>
      Uint8Array.from([...Array.from({ length: count }, () => [field(1, 3), 1]).flat(), STOP]);
    expect(safeParquetIndex(fields(20_000))).toBe(20_000);
    expect(() => safeParquetIndex(fields(20_001))).toThrow(
      'Parquet metadata element budget exceeded'
    );
    expect(safeParquetIndex(fields(19_999))).toBe(19_999);
  });
});

function pageHeader(fields: Record<string, unknown>): Uint8Array {
  const writer = new ByteWriter();
  serializeTCompactProtocol(writer, fields);
  return writer.getBytes();
}

describe('safeParquetHeader', () => {
  const data = (extra: Record<string, unknown> = {}) =>
    pageHeader({
      field_1: 0,
      field_2: 100,
      field_3: 50,
      field_5: { field_1: 10, field_2: 0, field_3: 3, field_4: 3 },
      ...extra,
    });

  it('reads a page header and reports its length', () => {
    const bytes = data();
    const { header, headerBytes } = safeParquetHeader(Uint8Array.from([...bytes, 1, 2, 3]));
    expect(header).toMatchObject({
      type: 'DATA_PAGE',
      uncompressed_page_size: 100,
      compressed_page_size: 50,
    });
    expect(headerBytes).toBe(bytes.byteLength);
  });

  it('refuses a negative page size', () => {
    expect(() => safeParquetHeader(data({ field_2: -1 }))).toThrow('Invalid Parquet page size');
    expect(() => safeParquetHeader(data({ field_3: -1 }))).toThrow('Invalid Parquet page size');
    expect(safeParquetHeader(data({ field_2: 0, field_3: 0 })).header.compressed_page_size).toBe(0);
  });

  it('reads only the first 64 KiB and bounds its elements', () => {
    const bytes = data();
    const padded = new Uint8Array(bytes.byteLength + 200_000);
    padded.set(bytes);
    expect(safeParquetHeader(padded).headerBytes).toBe(bytes.byteLength);
    const writer = new ByteWriter();
    serializeTCompactProtocol(writer, {
      field_1: 0,
      field_2: 1,
      field_3: 1,
      field_5: { field_1: 1, field_2: 0, field_3: 3, field_4: 3 },
      field_6: Array.from({ length: 1025 }, () => 1),
    });
    expect(() => safeParquetHeader(writer.getBytes())).toThrow(IcebergBudgetError);
  });
});

describe('safeParquetFooter', () => {
  async function parquet(): Promise<Uint8Array> {
    const f = readerFixture();
    await f.append('footer', [record({ event_id: 'a' }), record({ event_id: 'b' })]);
    const path = [...f.store.objects.keys()].find((key) => key.endsWith('.parquet'));
    return Uint8Array.from(f.store.objects.get(String(path))?.bytes ?? []);
  }

  const metadataLength = (bytes: Uint8Array): number =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      bytes.byteLength - 8,
      true
    );

  function footerWith(bytes: Uint8Array, thrift: Uint8Array): Uint8Array {
    const out = new Uint8Array(thrift.byteLength + 8);
    out.set(thrift);
    new DataView(out.buffer).setUint32(thrift.byteLength, thrift.byteLength, true);
    out.set(text('PAR1'), thrift.byteLength + 4);
    return out;
  }

  it('reads the metadata of a Parquet file', async () => {
    const bytes = await parquet();
    const metadata = safeParquetFooter(bytes);
    expect(Number(metadata.num_rows)).toBe(2);
    expect(metadata.row_groups).toHaveLength(1);
  });

  it('refuses a footer shorter than eight bytes', () => {
    expect(() => safeParquetFooter(new Uint8Array(7))).toThrow('Invalid Parquet footer');
    expect(() => safeParquetFooter(new Uint8Array(0))).toThrow('Invalid Parquet footer');
    expect(() => safeParquetFooter(new Uint8Array(8))).not.toThrow('Invalid Parquet footer');
  });

  it('refuses a metadata length over 256 KiB or over the bytes available', async () => {
    const bytes = await parquet();
    const total = metadataLength(bytes);
    const tail = bytes.subarray(bytes.byteLength - total - 8);
    const copy = Uint8Array.from(tail);
    new DataView(copy.buffer).setUint32(copy.byteLength - 8, copy.byteLength - 7, true);
    expect(() => safeParquetFooter(copy)).toThrow('Parquet footer budget exceeded');
    const big = new Uint8Array(256 * 1024 + 8 + 16);
    new DataView(big.buffer).setUint32(big.byteLength - 8, 256 * 1024 + 1, true);
    expect(() => safeParquetFooter(big)).toThrow('Parquet footer budget exceeded');
    expect(safeParquetFooter(tail).num_rows).toBeDefined();
  });

  it('refuses metadata that has bytes after the struct, or that nests too deep', async () => {
    const bytes = await parquet();
    const total = metadataLength(bytes);
    const thrift = bytes.subarray(bytes.byteLength - total - 8, bytes.byteLength - 8);
    expect(() => safeParquetFooter(footerWith(bytes, Uint8Array.from([...thrift, 0])))).toThrow(
      'Parquet footer trailing bytes'
    );
    let nested: number[] = [STOP];
    for (let i = 0; i < 17; i += 1) nested = [field(1, 12), ...nested, STOP];
    expect(() => safeParquetFooter(footerWith(bytes, Uint8Array.from(nested)))).toThrow(
      'Parquet metadata nesting exceeded'
    );
  });
});
