import { describe, expect, it } from 'vitest';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { serializeTCompactProtocol } from 'hyparquet-writer/src/thrift.js';
import {
  safeAvro,
  safeParquetFooter,
  safeParquetHeader,
  safeParquetIndex,
  safeParquetPages,
  safeZstd,
} from '../read-safety.js';
import { IcebergBudgetError } from '../types.js';

const encoder = new TextEncoder();

function avroLong(number: number): number[] {
  let value = number >= 0 ? BigInt(number) * 2n : BigInt(-number) * 2n - 1n;
  const encoded: number[] = [];
  while (value >= 128n) {
    encoded.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  encoded.push(Number(value));
  return encoded;
}

function avroString(value: string): number[] {
  const bytes = encoder.encode(value);
  return [...avroLong(bytes.byteLength), ...bytes];
}

function avroObject(options: {
  schema: unknown;
  codec?: string;
  rows?: number;
  block?: readonly number[];
}): Uint8Array {
  const schema = JSON.stringify(options.schema);
  const block = options.block ?? [];
  const sync = Array.from({ length: 16 }, (_, index) => index);
  return Uint8Array.from([
    79,
    98,
    106,
    1,
    ...avroLong(2),
    ...avroString('avro.schema'),
    ...avroString(schema),
    ...avroString('avro.codec'),
    ...avroString(options.codec ?? 'null'),
    ...avroLong(0),
    ...sync,
    ...avroLong(options.rows ?? 1),
    ...avroLong(block.length),
    ...block,
    ...sync,
  ]);
}

function rawZstdFrame(payload: readonly number[]): Uint8Array {
  return Uint8Array.from([
    0x28,
    0xb5,
    0x2f,
    0xfd,
    0x20,
    payload.length,
    (payload.length << 3) | 1,
    0,
    0,
    ...payload,
  ]);
}

function snappyPage(payload: readonly number[]): Uint8Array {
  const writer = new ByteWriter();
  serializeTCompactProtocol(writer, {
    field_1: 0,
    field_2: 4,
    field_3: payload.length,
    field_5: { field_1: 1, field_2: 0, field_3: 3, field_4: 3 },
  });
  return Uint8Array.from([...writer.getBytes(), ...payload]);
}

describe('bounded metadata and page preflight', () => {
  it('rejects an advertised Parquet list larger than the metadata element budget', () => {
    // Compact Thrift list length 20,001, encoded as an unsigned varint.
    expect(() => safeParquetIndex(Uint8Array.from([0x19, 0xf3, 0xa1, 0x9c, 0x01]))).toThrow(
      IcebergBudgetError
    );
    expect(() => safeParquetIndex(Uint8Array.from([0, 1]))).toThrow('trailing bytes');
  });

  it('rejects a Parquet footer with an advertised metadata allocation beyond its cap', () => {
    const footer = new Uint8Array(8);
    new DataView(footer.buffer).setUint32(0, 256 * 1024 + 1, true);
    expect(() => safeParquetFooter(footer)).toThrow(IcebergBudgetError);
  });

  it('rejects malformed page lengths and unsupported codecs before decoding a chunk', () => {
    const writer = new ByteWriter();
    serializeTCompactProtocol(writer, {
      field_1: 0,
      field_2: 4,
      field_3: 4,
      field_5: { field_1: 1, field_2: 0, field_3: 3, field_4: 3 },
    });
    const header = writer.getBytes();
    const chunk = Uint8Array.from([...header, 0]);
    expect(safeParquetHeader(header).headerBytes).toBe(header.byteLength);
    expect(() => safeParquetPages(chunk, 1, 16, 'LZ4')).toThrow(
      'Unsupported bounded Parquet codec'
    );
    expect(() => safeParquetPages(chunk, 1, 16, 'UNCOMPRESSED')).toThrow(
      'Parquet page exceeds column chunk'
    );
  });

  it('rejects malformed Snappy copy offsets and output lengths before decompression', () => {
    const column = { type: 'INT32', optional: false };
    const inspect = (payload: number[]) =>
      safeParquetPages(snappyPage(payload), 1, 16, 'SNAPPY', column);

    expect(inspect([4, 12, 1, 2, 3, 4])).toBe(4);
    expect(() => inspect([3, 8, 1, 2, 3])).toThrow(
      'Snappy decoded length differs from Parquet header'
    );
    expect(() => inspect([4, 1, 0])).toThrow('Invalid Snappy copy offset');
    expect(() => inspect([4, 16, 1, 2, 3, 4, 5])).toThrow(IcebergBudgetError);
    expect(() => inspect([4, 12, 1, 2, 3])).toThrow('Invalid bounded binary length');
  });
});

describe('bounded Avro manifest preflight', () => {
  it('accepts a null-coded block and rejects a compressed manifest before decoding', () => {
    expect(safeAvro(avroObject({ schema: 'null' })).rows).toBe(1);
    expect(() => safeAvro(avroObject({ schema: 'null', codec: 'deflate' }))).toThrow(
      'Compressed Avro manifest'
    );
  });

  it('rejects a forged manifest header count and a block row count above its cap', () => {
    expect(() => safeAvro(Uint8Array.from([79, 98, 106, 1, ...avroLong(65)]))).toThrow(
      IcebergBudgetError
    );
    expect(() => safeAvro(avroObject({ schema: 'null', rows: 10_001 }))).toThrow(
      'Avro manifest row budget exceeded'
    );
  });

  it('rejects an out-of-range union choice and unused bytes inside a record block', () => {
    expect(() =>
      safeAvro(avroObject({ schema: ['null', 'string'], block: [...avroLong(2), 0, 0] }))
    ).toThrow('Invalid Avro union selection');
    expect(() => safeAvro(avroObject({ schema: 'null', block: [1] }))).toThrow(
      'Avro block trailing data'
    );
  });

  it('rejects a forged block sync and schema nesting beyond its traversal bound', () => {
    const bytes = avroObject({ schema: 'null' });
    bytes[bytes.length - 1] ^= 1;
    expect(() => safeAvro(bytes)).toThrow('Avro sync mismatch');
    let schema: unknown = 'null';
    for (let depth = 0; depth < 17; depth++) schema = { type: 'array', items: schema };
    expect(() => safeAvro(avroObject({ schema }))).toThrow('Avro schema depth exceeded');
  });
});

describe('bounded ZSTD frame preflight', () => {
  it('accepts a tiny raw frame but rejects allocation across concatenated frames', () => {
    const frame = rawZstdFrame([1, 2, 3]);
    expect(safeZstd(frame, 3)).toBe(3);
    expect(() => safeZstd(Uint8Array.from([...frame, ...frame]), 6, 5)).toThrow(IcebergBudgetError);
  });

  it('rejects reserved frame flags, an external dictionary, and a reserved block type', () => {
    const flagged = rawZstdFrame([1]);
    flagged[4] |= 0x08;
    expect(() => safeZstd(flagged, 1)).toThrow('Unsupported ZSTD frame flags');

    const externalDictionary = Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0x21, 1, 1, 9, 0, 0, 1]);
    expect(() => safeZstd(externalDictionary, 1)).toThrow('External ZSTD dictionary');

    const reservedBlock = rawZstdFrame([1]);
    reservedBlock[6] = (1 << 3) | (3 << 1) | 1;
    expect(() => safeZstd(reservedBlock, 1)).toThrow('Invalid ZSTD block');
  });
});
