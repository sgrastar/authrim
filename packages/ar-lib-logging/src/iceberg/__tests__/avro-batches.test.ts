import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { avroWrite } from 'icebird/avro';
import { fetchAvroRecords } from 'icebird/src/fetch.js';
import { ByteWriter } from 'hyparquet-writer/src/bytewriter.js';
import { safeReadResolver } from '../read-buffer.js';

function long(value: number): Uint8Array {
  let n = BigInt(value) << 1n;
  const bytes: number[] = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    bytes.push(b | (n ? 128 : 0));
  } while (n);
  return Uint8Array.from(bytes);
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function text(value: string): Uint8Array {
  const data = new TextEncoder().encode(value);
  return join([long(data.length), data]);
}
function deflated(value: string, trailer = false): Uint8Array {
  const schema = JSON.stringify({
    type: 'record',
    name: 'stream_test',
    fields: [{ name: 'text', type: 'string' }],
  });
  const data = new Uint8Array(deflateRawSync(text(value)));
  const compressed = trailer ? join([data, Uint8Array.of(1, 2, 3)]) : data;
  const sync = new Uint8Array(16);
  return join([
    Uint8Array.of(79, 98, 106, 1),
    long(2),
    text('avro.schema'),
    text(schema),
    text('avro.codec'),
    text('deflate'),
    long(0),
    sync,
    long(1),
    long(compressed.length),
    compressed,
    sync,
  ]);
}
function resolver(data: Uint8Array) {
  return safeReadResolver({
    store: {
      read: async (_path, maximum) => {
        if (data.length > maximum) throw new Error('raw bound');
        return data;
      },
      putImmutable: async () => undefined,
    },
    maxFiles: 4,
    maxBytes: 8 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
    maxRows: 10_000,
    deadline: Date.now() + 10_000,
    filters: new Map(),
  });
}

describe('bounded streamed manifest batches', () => {
  it('streams more than ten thousand descriptors without retaining the full decoded graph', async () => {
    const writer = new ByteWriter();
    await avroWrite({
      writer,
      schema: { type: 'record', name: 'descriptor', fields: [{ name: 'id', type: 'long' }] },
      records: Array.from({ length: 25_000 }, (_, i) => ({ id: BigInt(i) })),
    });
    let count = 0;
    let last: unknown;
    for await (const batch of resolver(writer.getBytes()).avroBatches('list.avro')) {
      expect(batch.records.length).toBeLessThanOrEqual(32);
      count += batch.records.length;
      last = batch.records[batch.records.length - 1];
    }
    expect(count).toBe(25_000);
    expect(last).toEqual({ id: 24_999n });
  });
  it('preserves a header-only empty OCF for the native lifecycle helpers', async () => {
    const writer = new ByteWriter();
    await avroWrite({
      writer,
      schema: { type: 'record', name: 'empty_manifest', fields: [{ name: 'id', type: 'long' }] },
      records: [],
    });
    expect(await fetchAvroRecords('empty.avro', resolver(writer.getBytes()))).toEqual([]);
  });
  it('supports normal raw-deflate OCF without handing compressed bytes to the growing upstream decoder', async () => {
    const data = deflated('日本語🔒');
    const batches = [];
    for await (const batch of resolver(data).avroBatches('deflate.avro'))
      batches.push(...batch.records);
    expect(batches).toEqual([{ text: '日本語🔒' }]);
    expect(await fetchAvroRecords('deflate.avro', resolver(data))).toEqual(batches);
  });
  it('preserves integer DAY partition values when Avro carries a date logical annotation', async () => {
    const writer = new ByteWriter();
    const date = new Date('2026-10-26T00:00:00Z');
    await avroWrite({
      writer,
      schema: {
        type: 'record',
        name: 'partition',
        fields: [{ name: 'day', type: ['null', { type: 'int', logicalType: 'date' }] }],
      },
      records: [{ day: date }],
    });
    const expected = [{ day: date.valueOf() / 86_400_000 }];
    const rows = [];
    for await (const batch of resolver(writer.getBytes()).avroBatches('day.avro'))
      rows.push(...batch.records);
    expect(rows).toEqual(expected);
    expect(await fetchAvroRecords('day.avro', resolver(writer.getBytes()))).toEqual(expected);
  });

  it('rejects inflated blocks over four MiB and invalid compressed data', async () => {
    const collect = async (data: Uint8Array) => {
      for await (const batch of resolver(data).avroBatches('bad.avro')) void batch;
    };
    await expect(collect(deflated('x'.repeat(5 * 1024 * 1024)))).rejects.toThrow(
      'inflated block budget'
    );
    const invalid = deflated('valid');
    invalid[invalid.length - 18] ^= 255;
    await expect(collect(invalid)).rejects.toThrow();
  });
});
