import { decompressZstd } from 'hyparquet-compressors';
import { snappyUncompress } from 'hyparquet/src/snappy.js';
import { parquetMetadata } from 'hyparquet/src/metadata.js';
import { parquetHeader } from 'hyparquet/src/column.js';
import { IcebergBudgetError } from './types.js';

class Cursor {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength)
      throw new Error('Invalid bounded binary length');
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  byte(): number {
    const value = this.take(1)[0];
    return value;
  }
  unsigned(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid binary varint');
  }
  long(): bigint {
    const value = this.unsigned();
    return (value >> 1n) ^ -(value & 1n);
  }
  length(): number {
    const value = this.long();
    if (value < 0n || value > BigInt(this.bytes.byteLength))
      throw new Error('Invalid bounded Avro length');
    return Number(value);
  }
}

/** Check compact-Thrift container lengths BEFORE upstream creates arrays. */
function checkThrift(cursor: Cursor, depth = 0, budget = { elements: 20_000 }): void {
  if (depth > 16) throw new IcebergBudgetError('Parquet metadata nesting exceeded');
  const element = (type: number, nested: number, inList = false): void => {
    if (--budget.elements < 0)
      throw new IcebergBudgetError('Parquet metadata element budget exceeded');
    if (type === 1 || type === 2) {
      if (inList) cursor.take(1);
    } else if (type === 3) cursor.take(1);
    else if (type === 4 || type === 5 || type === 6) cursor.unsigned();
    else if (type === 7) cursor.take(8);
    else if (type === 8) {
      const n = cursor.unsigned();
      if (n > BigInt(cursor.bytes.byteLength))
        throw new IcebergBudgetError('Parquet metadata string budget exceeded');
      cursor.take(Number(n));
    } else if (type === 9) {
      const header = cursor.byte();
      const encoded = header >> 4;
      const length = encoded === 15 ? cursor.unsigned() : BigInt(encoded);
      if (
        length > BigInt(budget.elements) ||
        length > BigInt(cursor.bytes.byteLength - cursor.offset)
      )
        throw new IcebergBudgetError('Parquet metadata list budget exceeded');
      for (let i = 0; i < Number(length); i++) element(header & 15, nested + 1, true);
    } else if (type === 12) checkThrift(cursor, nested + 1, budget);
    else throw new Error('Unsupported bounded Parquet metadata type');
  };
  while (true) {
    const header = cursor.byte();
    if ((header & 15) === 0) return;
    if (!(header >> 4)) cursor.unsigned();
    element(header & 15, depth);
  }
}
export function safeParquetIndex(bytes: Uint8Array): number {
  const cursor = new Cursor(bytes);
  const budget = { elements: 20_000 };
  checkThrift(cursor, 0, budget);
  if (cursor.offset !== bytes.byteLength) throw new Error('Parquet index trailing bytes');
  return 20_000 - budget.elements;
}

export function safeParquetHeader(bytes: Uint8Array): {
  header: ReturnType<typeof parquetHeader>;
  headerBytes: number;
} {
  const cursor = new Cursor(bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1024)));
  checkThrift(cursor, 0, { elements: 1024 });
  const reader = {
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  };
  const header = parquetHeader(reader);
  for (const value of [header.compressed_page_size, header.uncompressed_page_size])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Parquet page size');
  return { header, headerBytes: reader.offset };
}

export function safeParquetFooter(footer: Uint8Array): ReturnType<typeof parquetMetadata> {
  if (footer.byteLength < 8) throw new Error('Invalid Parquet footer');
  const view = new DataView(footer.buffer, footer.byteOffset, footer.byteLength);
  const length = view.getUint32(footer.byteLength - 8, true);
  if (length > 256 * 1024 || length > footer.byteLength - 8)
    throw new IcebergBudgetError('Parquet footer budget exceeded');
  const cursor = new Cursor(footer.subarray(footer.byteLength - 8 - length, footer.byteLength - 8));
  checkThrift(cursor);
  if (cursor.offset !== cursor.bytes.byteLength) throw new Error('Parquet footer trailing bytes');
  return parquetMetadata(footer, { geoparquet: false });
}

/** Called on selected compressed column chunks before any decompressor runs. */
export function safeParquetPages(
  bytes: Uint8Array,
  rowLimit: number,
  decodedLimit: number,
  codec = 'UNCOMPRESSED',
  column?: { type: string; optional: boolean; dictionaryValues?: number }
): number {
  const reader = {
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    offset: 0,
  };
  let decoded = 0;
  let pages = 0;
  let dictionaryValues: number | undefined = column?.dictionaryValues;
  while (reader.offset < bytes.byteLength) {
    if (++pages > 4096) throw new IcebergBudgetError('Parquet page budget exceeded');
    const cursor = new Cursor(
      bytes.subarray(reader.offset, Math.min(bytes.byteLength, reader.offset + 64 * 1024))
    );
    checkThrift(cursor, 0, { elements: 1024 });
    const header = parquetHeader(reader);
    for (const size of [header.compressed_page_size, header.uncompressed_page_size]) {
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Parquet page size');
    }
    const before = decoded;
    decoded += header.uncompressed_page_size;
    if (decoded > decodedLimit)
      throw new IcebergBudgetError('Parquet decoded byte budget exceeded');
    const values =
      header.data_page_header?.num_values ??
      header.data_page_header_v2?.num_values ??
      header.dictionary_page_header?.num_values;
    if (values === undefined || !Number.isSafeInteger(values) || values < 0 || values > rowLimit)
      throw new IcebergBudgetError('Parquet page value budget exceeded');
    const v2 = header.data_page_header_v2;
    if (
      v2 &&
      (!Number.isSafeInteger(v2.num_rows) ||
        v2.num_rows < 0 ||
        v2.num_rows > rowLimit ||
        v2.num_nulls < 0 ||
        v2.num_nulls > v2.num_values ||
        v2.definition_levels_byte_length < 0 ||
        v2.repetition_levels_byte_length < 0 ||
        v2.definition_levels_byte_length + v2.repetition_levels_byte_length >
          header.uncompressed_page_size)
    )
      throw new Error('Invalid Parquet v2 page bounds');
    if (!['SNAPPY', 'UNCOMPRESSED', 'ZSTD'].includes(codec))
      throw new Error('Unsupported bounded Parquet codec');
    const levels = v2 ? v2.definition_levels_byte_length + v2.repetition_levels_byte_length : 0;
    if (codec === 'ZSTD' && v2?.is_compressed !== false) {
      const allocation = safeZstd(
        bytes.subarray(reader.offset + levels, reader.offset + header.compressed_page_size),
        header.uncompressed_page_size - levels,
        decodedLimit - before - levels
      );
      decoded = before + levels + Math.max(header.uncompressed_page_size - levels, allocation);
    }
    if (column) {
      const payload = bytes.subarray(reader.offset, reader.offset + header.compressed_page_size);
      const compressed = payload.subarray(levels);
      const expected = header.uncompressed_page_size - levels;
      let plain: Uint8Array;
      if (codec === 'UNCOMPRESSED' || v2?.is_compressed === false) plain = compressed;
      else if (codec === 'ZSTD') plain = decompressZstd(compressed, new Uint8Array(expected));
      else {
        safeSnappy(compressed, expected);
        plain = new Uint8Array(expected);
        snappyUncompress(compressed, plain);
      }
      if (plain.byteLength !== expected) throw new Error('Invalid decoded Parquet page length');
      if (header.dictionary_page_header) {
        if (header.dictionary_page_header.encoding !== 'PLAIN')
          throw new Error('Unsupported dictionary encoding');
        dictionaryValues = header.dictionary_page_header.num_values;
        safePlainValues(new Cursor(plain), column.type, dictionaryValues);
      } else {
        const body = new Cursor(plain);
        const count = values;
        let present = count;
        if (v2) {
          if (v2.repetition_levels_byte_length !== 0)
            throw new Error('Repeated Parquet fields are unsupported');
          if (column.optional)
            present = safeHybrid(new Cursor(payload.subarray(0, levels)), 1, count).nonzero;
          if (present !== count - v2.num_nulls)
            throw new Error('Parquet null count differs from definition levels');
        } else if (column.optional) {
          if (header.data_page_header?.definition_level_encoding !== 'RLE')
            throw new Error('Unsupported definition level encoding');
          const lengthBytes = body.take(4);
          const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(
            0,
            true
          );
          present = safeHybrid(new Cursor(body.take(length)), 1, count).nonzero;
        }
        const encoding = header.data_page_header?.encoding ?? v2?.encoding;
        if (encoding === 'PLAIN') safePlainValues(body, column.type, present);
        else if (encoding === 'RLE_DICTIONARY' || encoding === 'PLAIN_DICTIONARY') {
          const width = body.byte();
          if (width > 32 || dictionaryValues === undefined)
            throw new Error('Invalid dictionary index encoding');
          if (width) {
            const result = safeHybrid(body, width, present);
            if (result.maximum >= dictionaryValues)
              throw new Error('Dictionary index outside dictionary');
          } else if (present && dictionaryValues < 1) throw new Error('Dictionary is empty');
        } else throw new Error('Unsupported bounded Parquet value encoding');
      }
    }
    reader.offset += header.compressed_page_size;
    if (reader.offset > bytes.byteLength) throw new Error('Parquet page exceeds column chunk');
  }
  return decoded;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Iceberg manifests written by Authrim use null-codec OCF. Reject compressed
 * OCF until its decoder provides a verified maximum output allocation. */
export interface AvroReadMetrics {
  rows: number;
  nodes: number;
  containerEntries: number;
  stringBytes: number;
  binaryBytes: number;
  schemaBytes: number;
  estimatedDecodedBytes: number;
}

export function safeAvro(bytes: Uint8Array): AvroReadMetrics {
  const metrics: AvroReadMetrics = {
    rows: 0,
    nodes: 0,
    containerEntries: 0,
    stringBytes: 0,
    binaryBytes: 0,
    schemaBytes: 0,
    estimatedDecodedBytes: 0,
  };
  let headerEntries = 0;
  const cursor = new Cursor(bytes);
  if (String.fromCharCode(...cursor.take(4)) !== 'Obj\u0001')
    throw new Error('Invalid Iceberg Avro magic');
  const header = new Map<string, Uint8Array>();
  let count = cursor.long();
  while (count !== 0n) {
    if (count < 0n) {
      count = -count;
      cursor.length();
    }
    if (count > 64n || (headerEntries += Number(count)) > 64)
      throw new IcebergBudgetError('Avro header budget exceeded');
    for (let i = 0; i < Number(count); i++) {
      const encodedKey = cursor.take(cursor.length());
      const key = new TextDecoder().decode(encodedKey);
      const value = cursor.take(cursor.length());
      metrics.stringBytes += encodedKey.byteLength + value.byteLength;
      header.set(key, value);
    }
    count = cursor.long();
  }
  const codec = new TextDecoder().decode(header.get('avro.codec'));
  if (codec && codec !== 'null')
    throw new Error('Compressed Avro manifest is not supported by the bounded reader');
  const schemaBytes = header.get('avro.schema');
  if (!schemaBytes || schemaBytes.byteLength > 64 * 1024)
    throw new IcebergBudgetError('Avro schema budget exceeded');
  // Upstream parses these recognized header strings as JSON, independently
  // for every manifest. Include schemas even when the payload has zero bytes.
  for (const name of ['avro.schema', 'schema', 'iceberg.schema']) {
    const encoded = header.get(name);
    if (encoded) {
      if (encoded.byteLength > 64 * 1024)
        throw new IcebergBudgetError('Avro schema budget exceeded');
      metrics.schemaBytes += encoded.byteLength;
    }
  }
  const schema: unknown = JSON.parse(new TextDecoder().decode(schemaBytes));
  const names = new Map<string, unknown>();
  const visit = (type: unknown, depth: number): void => {
    if (depth > 16) throw new IcebergBudgetError('Avro schema depth exceeded');
    if (Array.isArray(type)) {
      if (type.length > 8) throw new Error('Invalid Avro union');
      type.forEach((child: unknown) => visit(child, depth + 1));
    } else if (record(type)) {
      if (typeof type.name === 'string') names.set(type.name, type);
      if (type.type === 'record') {
        if (!Array.isArray(type.fields) || type.fields.length > 64)
          throw new Error('Invalid Avro schema fields');
        for (const field of type.fields as unknown[]) {
          if (!record(field)) throw new Error('Invalid Avro field');
          visit(field.type, depth + 1);
        }
      } else if (type.type === 'array') visit(type.items, depth + 1);
      else if (type.type === 'map') visit(type.values, depth + 1);
    } else if (typeof type !== 'string') throw new Error('Invalid Avro schema');
  };
  visit(schema, 0);
  const sync = cursor.take(16);
  const node = (): void => {
    if (++metrics.nodes > 200_000)
      throw new IcebergBudgetError('Avro decoded value budget exceeded');
  };
  const skip = (data: Cursor, type: unknown, depth = 0): void => {
    if (depth > 24) throw new IcebergBudgetError('Avro decoded value budget exceeded');
    node();
    if (Array.isArray(type)) {
      const index = data.length();
      if (index >= type.length) throw new Error('Invalid Avro union selection');
      skip(data, type[index], depth + 1);
      return;
    }
    if (record(type)) {
      if (type.type === 'record') {
        for (const field of type.fields as Record<string, unknown>[])
          skip(data, field.type, depth + 1);
        return;
      }
      if (type.type === 'fixed') {
        if (typeof type.size !== 'number' || type.size > 4096)
          throw new Error('Invalid Avro fixed');
        data.take(type.size);
        metrics.binaryBytes += type.size;
        return;
      }
      if (type.type === 'array' || type.type === 'map') {
        let n = data.long();
        while (n !== 0n) {
          if (n < 0n) {
            n = -n;
            data.length();
          }
          if (n > 4096n || (metrics.containerEntries += Number(n)) > 200_000)
            throw new IcebergBudgetError('Avro collection budget exceeded');
          for (let i = 0; i < Number(n); i++) {
            if (type.type === 'map') {
              node();
              const key = data.take(data.length());
              metrics.stringBytes += key.byteLength;
            }
            skip(data, type.type === 'map' ? type.values : type.items, depth + 1);
          }
          n = data.long();
        }
        return;
      }
      skip(data, type.type, depth + 1);
      return;
    }
    if (type === 'null') return;
    if (type === 'long' || type === 'int') {
      data.unsigned();
      return;
    }
    if (type === 'boolean') {
      data.take(1);
      return;
    }
    if (type === 'float') {
      data.take(4);
      return;
    }
    if (type === 'double') {
      data.take(8);
      return;
    }
    if (type === 'bytes' || type === 'string') {
      const value = data.take(data.length());
      if (type === 'string') metrics.stringBytes += value.byteLength;
      else metrics.binaryBytes += value.byteLength;
      return;
    }
    if (typeof type === 'string' && names.has(type)) {
      skip(data, names.get(type), depth + 1);
      return;
    }
    throw new Error('Unsupported bounded Avro type');
  };
  while (cursor.offset < bytes.byteLength) {
    const n = cursor.long();
    if (n === 0n) break;
    if (n < 0n || n > 10_000n || (metrics.rows += Number(n)) > 10_000)
      throw new IcebergBudgetError('Avro manifest row budget exceeded');
    const data = new Cursor(cursor.take(cursor.length()));
    for (let i = 0; i < Number(n); i++) skip(data, schema);
    if (data.offset !== data.bytes.byteLength) throw new Error('Avro block trailing data');
    const actual = cursor.take(16);
    if (actual.some((b, i) => b !== sync[i])) throw new Error('Avro sync mismatch');
  }
  // Conservative retained-allocation charge: JS values/property slots and
  // collection entries, UTF-16 text, byte views, and both schema parsing and
  // compiled decoder structures. This is a budget charge, not a heap profiler.
  metrics.estimatedDecodedBytes =
    metrics.nodes * 64 +
    metrics.containerEntries * 8 +
    metrics.stringBytes * 2 +
    metrics.binaryBytes +
    metrics.schemaBytes * 32 +
    headerEntries * 128;
  return metrics;
}

/** Inspect every concatenated ZSTD frame before the upstream decoder allocates
 * its output/window. Unknown-size frames use the specification maximum output
 * per block; their entire output/window bound is reserved before decoding. */
export function safeZstd(
  bytes: Uint8Array,
  expectedOutput: number,
  allocationLimit = expectedOutput
): number {
  const cursor = new Cursor(bytes);
  let decoded = 0;
  let allocations = 0;
  let unknownSize = false;
  while (cursor.offset < bytes.byteLength) {
    const magicBytes = cursor.take(4);
    const magic = new DataView(magicBytes.buffer, magicBytes.byteOffset, 4).getUint32(0, true);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      const sizeBytes = cursor.take(4);
      cursor.take(new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 4).getUint32(0, true));
      continue;
    }
    if (magic !== 0xfd2fb528) throw new Error('Invalid ZSTD frame magic');
    const descriptor = cursor.byte();
    if (descriptor & 0x18) throw new Error('Unsupported ZSTD frame flags');
    const single = Boolean(descriptor & 0x20);
    const flag = descriptor >> 6;
    let window = 0;
    if (!single) {
      const wd = cursor.byte();
      const base = 2 ** (10 + (wd >> 3));
      window = base + (base / 8) * (wd & 7);
    }
    const dictionarySize = [0, 1, 2, 4][descriptor & 3];
    if (cursor.take(dictionarySize).some((byte) => byte !== 0))
      throw new Error('External ZSTD dictionary is unsupported');
    const fcsSize = flag === 0 ? (single ? 1 : 0) : flag === 1 ? 2 : flag === 2 ? 4 : 8;
    if (!fcsSize) unknownSize = true;
    const fcsBytes = cursor.take(fcsSize);
    let size = 0n;
    for (let i = 0; i < fcsSize; i++) size |= BigInt(fcsBytes[i]) << BigInt(8 * i);
    if (flag === 1) size += 256n;
    if (size > BigInt(expectedOutput) || window > allocationLimit)
      throw new IcebergBudgetError('ZSTD frame allocation exceeds decoded budget');
    decoded += Number(size);
    if (decoded > expectedOutput)
      throw new IcebergBudgetError('ZSTD concatenated frames exceed decoded budget');
    let last = false;
    let blockOutputBound = 0;
    while (!last) {
      const h = cursor.take(3);
      const value = h[0] | (h[1] << 8) | (h[2] << 16);
      last = Boolean(value & 1);
      const type = (value >> 1) & 3;
      const length = value >>> 3;
      if (type === 3 || length > 128 * 1024) throw new Error('Invalid ZSTD block');
      cursor.take(type === 1 ? 1 : length);
      blockOutputBound += type === 2 ? Math.min(window || Number(size), 128 * 1024) : length;
      if (blockOutputBound > allocationLimit)
        throw new IcebergBudgetError('ZSTD unknown-size output exceeds budget');
    }
    allocations += (fcsSize ? Number(size) : blockOutputBound) + window;
    if (allocations > allocationLimit)
      throw new IcebergBudgetError('ZSTD output/window allocation budget exceeded');
    if (descriptor & 4) cursor.take(4);
  }
  if (!unknownSize && decoded !== expectedOutput)
    throw new Error('ZSTD output length differs from Parquet page header');
  return allocations;
}

function safePlainValues(cursor: Cursor, type: string, count: number): void {
  if (type === 'INT32') {
    cursor.take(count * 4);
    return;
  }
  if (type === 'INT64') {
    cursor.take(count * 8);
    return;
  }
  if (type === 'BYTE_ARRAY') {
    for (let i = 0; i < count; i++) {
      const bytes = cursor.take(4);
      const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
      cursor.take(length);
    }
    return;
  }
  throw new Error('Unsupported bounded Parquet primitive');
}
/** Bound runs BEFORE upstream expands a normal JS array from payload counts. */
function safeHybrid(
  cursor: Cursor,
  width: number,
  count: number
): { nonzero: number; maximum: number } {
  let seen = 0;
  let nonzero = 0;
  let maximum = 0;
  while (seen < count) {
    const header = cursor.unsigned();
    const packed = Boolean(header & 1n);
    const run = Number(header >> 1n) * (packed ? 8 : 1);
    if (!Number.isSafeInteger(run) || run < 1 || run > count - seen + 7)
      throw new IcebergBudgetError('Parquet RLE run exceeds page value budget');
    if (packed) {
      const data = cursor.take(Math.ceil((run * width) / 8));
      for (let i = 0; i < run; i++) {
        let value = 0;
        for (let bit = 0; bit < width; bit++) {
          const offset = i * width + bit;
          if ((data[offset >> 3] >> (offset & 7)) & 1) value += 2 ** bit;
        }
        if (i < count - seen) {
          if (value) nonzero++;
          maximum = Math.max(maximum, value);
        }
      }
    } else {
      const encoded = cursor.take(Math.ceil(width / 8));
      let value = 0;
      for (let i = 0; i < encoded.length; i++) value += encoded[i] * 2 ** (i * 8);
      maximum = Math.max(maximum, value);
      if (value) nonzero += Math.min(run, count - seen);
    }
    seen += run;
  }
  return { nonzero, maximum };
}

function safeSnappy(bytes: Uint8Array, expected: number): void {
  const cursor = new Cursor(bytes);
  if (cursor.unsigned() !== BigInt(expected))
    throw new Error('Snappy decoded length differs from Parquet header');
  let produced = 0;
  while (cursor.offset < bytes.byteLength) {
    const tag = cursor.byte();
    const kind = tag & 3;
    let length: number;
    let offset = 0;
    if (kind === 0) {
      const encoded = tag >> 2;
      if (encoded < 60) length = encoded + 1;
      else {
        const data = cursor.take(encoded - 59);
        length = 1;
        for (let i = 0; i < data.length; i++) length += data[i] * 2 ** (i * 8);
      }
      cursor.take(length);
    } else if (kind === 1) {
      length = 4 + ((tag >> 2) & 7);
      offset = ((tag & 0xe0) << 3) | cursor.byte();
    } else {
      length = 1 + (tag >> 2);
      const data = cursor.take(kind === 2 ? 2 : 4);
      for (let i = 0; i < data.length; i++) offset += data[i] * 2 ** (i * 8);
    }
    if (kind && (offset < 1 || offset > produced)) throw new Error('Invalid Snappy copy offset');
    produced += length;
    if (produced > expected) throw new IcebergBudgetError('Snappy payload exceeds decoded budget');
  }
  if (produced !== expected) throw new Error('Invalid Snappy decoded length');
}
