import { decompressZstd } from 'hyparquet-compressors';
import { snappyUncompress } from 'hyparquet/src/snappy.js';
import { safeParquetHeader } from './read-safety.js';
import { IcebergBudgetError } from './types.js';

export type FlatValue = string | number | bigint | null;
export type FlatProbe = FlatValue | Uint8Array;
class Bytes {
  offset = 0;
  constructor(readonly data: Uint8Array) {}
  take(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.data.byteLength)
      throw new Error('Flat Parquet value exceeds page');
    const value = this.data.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  byte(): number {
    return this.take(1)[0];
  }
  unsigned(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.byte();
      value += (byte & 127) * scale;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid flat Parquet varint');
      if (!(byte & 128)) return value;
      scale *= 128;
    }
    throw new Error('Invalid flat Parquet varint');
  }
}

/** Retain only requested values, including when a tiny RLE run represents
 * millions of rows. No array is allocated from an encoded run length. */
class HybridValues {
  private remaining = 0;
  private packed: Uint8Array | undefined;
  private packedOffset = 0;
  private value = 0;
  constructor(
    private readonly input: Bytes,
    private readonly width: number
  ) {
    if (width < 0 || width > 32) throw new Error('Unsupported Parquet bit width');
  }
  private run(): void {
    if (this.remaining) return;
    if (this.width === 0) {
      this.remaining = Number.MAX_SAFE_INTEGER;
      this.value = 0;
      return;
    }
    const header = this.input.unsigned();
    const packed = Boolean(header & 1);
    this.remaining = Math.floor(header / 2) * (packed ? 8 : 1);
    if (!Number.isSafeInteger(this.remaining) || this.remaining < 1)
      throw new Error('Invalid Parquet RLE run');
    if (packed) {
      this.packed = this.input.take(Math.ceil((this.remaining * this.width) / 8));
      this.packedOffset = 0;
    } else {
      this.packed = undefined;
      const data = this.input.take(Math.ceil(this.width / 8));
      this.value = 0;
      for (let i = 0; i < data.length; i++) this.value += data[i] * 2 ** (8 * i);
    }
  }
  next(): number {
    this.run();
    this.remaining--;
    if (!this.packed) return this.value;
    let value = 0;
    for (let bit = 0; bit < this.width; bit++) {
      const index = this.packedOffset + bit;
      if ((this.packed[index >> 3] >> (index & 7)) & 1) value += 2 ** bit;
    }
    this.packedOffset += this.width;
    return value;
  }
  skip(count: number): void {
    while (count > 0) {
      this.run();
      const take = Math.min(count, this.remaining);
      this.remaining -= take;
      if (this.packed) this.packedOffset += take * this.width;
      count -= take;
    }
  }
  ones(count: number): number {
    if (this.width !== 1) throw new Error('Definition levels are not flat');
    let ones = 0;
    while (count > 0) {
      this.run();
      const take = Math.min(count, this.remaining);
      if (!this.packed) {
        if (this.value > 1) throw new Error('Invalid flat definition level');
        ones += this.value * take;
        this.remaining -= take;
        count -= take;
      } else {
        for (let i = 0; i < take; i++) ones += this.next();
        count -= take;
      }
    }
    return ones;
  }
}

function plain(
  input: Bytes,
  type: string,
  reserve: (bytes: number) => void
): { read: () => FlatValue; skip: (count: number) => void } {
  const next = (keep: boolean): FlatValue => {
    if (type === 'INT32') {
      const data = input.take(4);
      return new DataView(data.buffer, data.byteOffset, 4).getInt32(0, true);
    }
    if (type === 'INT64') {
      const data = input.take(8);
      return new DataView(data.buffer, data.byteOffset, 8).getBigInt64(0, true);
    }
    if (type === 'BYTE_ARRAY') {
      const length = input.take(4);
      const size = new DataView(length.buffer, length.byteOffset, 4).getInt32(0, true);
      const data = input.take(size);
      if (!keep) return null;
      reserve(data.byteLength * 2);
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
    }
    throw new Error('Unsupported flat archive primitive');
  };
  return {
    read: () => next(true),
    skip: (count) => {
      if (type === 'INT32' || type === 'INT64') {
        input.take(count * (type === 'INT32' ? 4 : 8));
        return;
      }
      for (let i = 0; i < count; i++) next(false);
    },
  };
}

/** The caller validates the complete encoded page and reserves its decoded
 * bytes first. This adapter supports only the new flat primitive contract. */
export function decodeFlatPage(options: {
  page: Uint8Array;
  codec: string;
  column: { type: string; optional: boolean };
  rowStart: number;
  rowEnd: number;
  dictionary?: readonly FlatValue[];
  reserve: (bytes: number) => void;
}): { rows: number; values?: FlatValue[]; dictionary?: FlatValue[] } {
  const { header, headerBytes } = safeParquetHeader(options.page);
  const v2 = header.data_page_header_v2;
  const levels = v2 ? v2.definition_levels_byte_length + v2.repetition_levels_byte_length : 0;
  const payload = options.page.subarray(headerBytes, headerBytes + header.compressed_page_size);
  const encoded = payload.subarray(levels);
  const expected = header.uncompressed_page_size - levels;
  let decoded: Uint8Array;
  if (options.codec === 'UNCOMPRESSED' || v2?.is_compressed === false) decoded = encoded;
  else if (options.codec === 'ZSTD') decoded = decompressZstd(encoded, new Uint8Array(expected));
  else if (options.codec === 'SNAPPY') {
    decoded = new Uint8Array(expected);
    snappyUncompress(encoded, decoded);
  } else throw new Error('Unsupported bounded archive codec');
  if (decoded.byteLength !== expected) throw new Error('Flat page decoded length mismatch');
  const body = new Bytes(decoded);
  if (header.dictionary_page_header) {
    const count = header.dictionary_page_header.num_values;
    options.reserve(count * 32);
    const input = plain(body, options.column.type, options.reserve);
    const dictionary: FlatValue[] = [];
    for (let i = 0; i < count; i++) dictionary.push(input.read());
    return { rows: 0, dictionary };
  }
  const count = header.data_page_header?.num_values ?? v2?.num_values;
  if (
    count === undefined ||
    (v2 && v2.num_rows !== count) ||
    options.rowStart < 0 ||
    options.rowEnd > count ||
    options.rowEnd < options.rowStart
  )
    throw new Error('Invalid flat page row window');
  let definitions: HybridValues | undefined;
  if (options.column.optional) {
    let data: Uint8Array;
    if (v2) data = payload.subarray(0, levels);
    else {
      const length = body.take(4);
      data = body.take(new DataView(length.buffer, length.byteOffset, 4).getUint32(0, true));
    }
    definitions = new HybridValues(new Bytes(data), 1);
  }
  const skip = definitions ? definitions.ones(options.rowStart) : options.rowStart;
  const encoding = header.data_page_header?.encoding ?? v2?.encoding;
  let value: { read: () => FlatValue; skip: (count: number) => void };
  if (encoding === 'PLAIN') value = plain(body, options.column.type, options.reserve);
  else if (encoding === 'RLE_DICTIONARY' || encoding === 'PLAIN_DICTIONARY') {
    if (!options.dictionary) throw new Error('Flat dictionary is missing');
    const indices = new HybridValues(body, body.byte());
    value = {
      skip: (count) => indices.skip(count),
      read: () => {
        const index = indices.next();
        if (index >= (options.dictionary?.length ?? 0))
          throw new Error('Flat dictionary index outside dictionary');
        return options.dictionary?.[index] ?? null;
      },
    };
  } else throw new Error('Unsupported flat archive encoding');
  value.skip(skip);
  const result: FlatValue[] = [];
  options.reserve((options.rowEnd - options.rowStart) * 32);
  for (let i = options.rowStart; i < options.rowEnd; i++) {
    const present = definitions ? definitions.next() : 1;
    if (present !== 0 && present !== 1) throw new Error('Invalid flat definition level');
    result.push(present ? value.read() : null);
  }
  if (result.length > 10_000) throw new IcebergBudgetError('Flat archive row window exceeded');
  return { rows: count, values: result };
}

/** Filter-column scan with only matching row indexes retained. String probes
 * remain byte views, so nonmatching IDs never become allocated JS strings. */
export function selectFlatPagePositions(options: {
  page: Uint8Array;
  codec: string;
  column: { type: string; optional: boolean };
  rowStart: number;
  rowEnd: number;
  dictionary?: readonly FlatValue[];
  matches: (value: FlatProbe) => boolean;
  maxMatches: number;
  check: () => void;
}): { positions: number[]; nextRow: number } {
  const { header, headerBytes } = safeParquetHeader(options.page);
  const v2 = header.data_page_header_v2;
  if (header.dictionary_page_header) throw new Error('Cannot select rows from a dictionary page');
  const count = header.data_page_header?.num_values ?? v2?.num_values;
  if (
    count === undefined ||
    options.rowStart < 0 ||
    options.rowEnd > count ||
    options.rowEnd < options.rowStart ||
    options.maxMatches < 1
  )
    throw new Error('Invalid flat selection window');
  const levels = v2 ? v2.definition_levels_byte_length + v2.repetition_levels_byte_length : 0;
  const payload = options.page.subarray(headerBytes, headerBytes + header.compressed_page_size);
  const encoded = payload.subarray(levels);
  const expected = header.uncompressed_page_size - levels;
  let decoded: Uint8Array;
  if (options.codec === 'UNCOMPRESSED' || v2?.is_compressed === false) decoded = encoded;
  else if (options.codec === 'ZSTD') decoded = decompressZstd(encoded, new Uint8Array(expected));
  else if (options.codec === 'SNAPPY') {
    decoded = new Uint8Array(expected);
    snappyUncompress(encoded, decoded);
  } else throw new Error('Unsupported flat selection codec');
  if (decoded.byteLength !== expected) throw new Error('Flat selection decoded length mismatch');
  const body = new Bytes(decoded);
  let definitions: HybridValues | undefined;
  if (options.column.optional) {
    const data = v2
      ? payload.subarray(0, levels)
      : (() => {
          const bytes = body.take(4);
          return body.take(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true));
        })();
    definitions = new HybridValues(new Bytes(data), 1);
  }
  const prefix = definitions ? definitions.ones(options.rowStart) : options.rowStart;
  const encoding = header.data_page_header?.encoding ?? v2?.encoding;
  let read: () => FlatProbe;
  let skip: (count: number) => void;
  if (encoding === 'PLAIN') {
    read = () => {
      if (options.column.type === 'INT32') {
        const bytes = body.take(4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
      }
      if (options.column.type === 'INT64') {
        const bytes = body.take(8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
      }
      if (options.column.type === 'BYTE_ARRAY') {
        const bytes = body.take(4);
        return body.take(new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true));
      }
      throw new Error('Unsupported selection primitive');
    };
    skip = (count) => {
      if (options.column.type === 'INT32' || options.column.type === 'INT64')
        body.take(count * (options.column.type === 'INT32' ? 4 : 8));
      else for (let i = 0; i < count; i++) read();
    };
  } else if (encoding === 'RLE_DICTIONARY' || encoding === 'PLAIN_DICTIONARY') {
    if (!options.dictionary) throw new Error('Selection dictionary is missing');
    const values = new HybridValues(body, body.byte());
    skip = (count) => values.skip(count);
    read = () => {
      const index = values.next();
      if (index >= (options.dictionary?.length ?? 0))
        throw new Error('Selection dictionary index outside dictionary');
      return options.dictionary?.[index] ?? null;
    };
  } else throw new Error('Unsupported selection encoding');
  skip(prefix);
  const positions: number[] = [];
  let row = options.rowStart;
  for (; row < options.rowEnd; row++) {
    if ((row & 1023) === 0) options.check();
    const present = definitions ? definitions.next() : 1;
    if (present !== 0 && present !== 1) throw new Error('Invalid selection definition level');
    const value = present ? read() : null;
    if (options.matches(value)) {
      positions.push(row);
      if (positions.length === options.maxMatches) return { positions, nextRow: row + 1 };
    }
  }
  return { positions, nextRow: row };
}
