import { IcebergBudgetError } from './types.js';

class AvroCursor {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || this.offset + n > this.bytes.length)
      throw new Error('Invalid streamed Avro length');
    const value = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  long(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.take(1)[0];
      value |= BigInt(b & 127) << BigInt(7 * i);
      if (!(b & 128)) return (value >> 1n) ^ -(value & 1n);
    }
    throw new Error('Invalid streamed Avro varint');
  }
  length(): number {
    const n = this.long();
    if (n < 0n || n > BigInt(this.bytes.length)) throw new Error('Invalid streamed Avro length');
    return Number(n);
  }
}
function encodedLong(value: number): Uint8Array {
  let n = BigInt(value) << 1n;
  const out: number[] = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    out.push(b | (n ? 128 : 0));
  } while (n);
  return Uint8Array.from(out);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split null/raw-deflate OCF into bounded normal OCF blocks before the upstream
 * decoder materializes objects. Original schemas and record bytes are kept;
 * no format conversion or application-level interpretation occurs here. */
export async function* avroRecordBatches(
  bytes: Uint8Array,
  check: () => void
): AsyncGenerator<Uint8Array> {
  const cursor = new AvroCursor(bytes);
  if (String.fromCharCode(...cursor.take(4)) !== 'Obj\u0001')
    throw new Error('Invalid streamed Avro magic');
  const header = new Map<string, Uint8Array>();
  let n = cursor.long();
  let keys = 0;
  while (n !== 0n) {
    if (n < 0n) {
      n = -n;
      cursor.length();
    }
    if (n > 64n || (keys += Number(n)) > 64)
      throw new IcebergBudgetError('Avro header budget exceeded');
    for (let i = 0; i < Number(n); i++) {
      const key = new TextDecoder().decode(cursor.take(cursor.length()));
      header.set(key, cursor.take(cursor.length()));
    }
    n = cursor.long();
  }
  const schemaBytes = header.get('avro.schema');
  if (!schemaBytes || schemaBytes.length > 64 * 1024)
    throw new IcebergBudgetError('Avro schema budget exceeded');
  const codec = new TextDecoder().decode(header.get('avro.codec'));
  if (codec && codec !== 'null' && codec !== 'deflate')
    throw new Error('Unsupported bounded Avro codec');
  const schema: unknown = JSON.parse(new TextDecoder().decode(schemaBytes));
  const names = new Map<string, unknown>();
  let schemaNodes = 0;
  let normalizedDate = false;
  const register = (type: unknown, depth = 0): void => {
    if (++schemaNodes > 4096 || depth > 16)
      throw new IcebergBudgetError('Avro schema depth exceeded');
    if (Array.isArray(type)) {
      if (type.length > 8) throw new Error('Invalid Avro union');
      type.forEach((child: unknown) => register(child, depth + 1));
    } else if (object(type)) {
      // Iceberg DAY partition tuples are epoch-day ints. Keep that exact
      // primitive representation for the shared native delete writer, whose
      // input contract is int rather than JavaScript Date.
      if (type.type === 'int' && type.logicalType === 'date') {
        delete type.logicalType;
        normalizedDate = true;
      }
      if (typeof type.name === 'string') names.set(type.name, type);
      if (type.type === 'record') {
        if (!Array.isArray(type.fields) || type.fields.length > 64)
          throw new Error('Invalid Avro schema fields');
        for (const field of type.fields as unknown[]) {
          if (!object(field)) throw new Error('Invalid Avro field');
          register(field.type, depth + 1);
        }
      } else if (type.type === 'array') register(type.items, depth + 1);
      else if (type.type === 'map') register(type.values, depth + 1);
    } else if (typeof type !== 'string') throw new Error('Invalid Avro schema');
  };
  register(schema);
  if (normalizedDate) header.set('avro.schema', new TextEncoder().encode(JSON.stringify(schema)));
  const sync = cursor.take(16);
  const parts: Uint8Array[] = [Uint8Array.of(79, 98, 106, 1), encodedLong(header.size)];
  for (const [key, original] of header) {
    const name = new TextEncoder().encode(key);
    const value = key === 'avro.codec' ? new TextEncoder().encode('null') : original;
    parts.push(encodedLong(name.length), name, encodedLong(value.length), value);
  }
  if (!header.has('avro.codec')) throw new Error('Avro codec header missing');
  parts.push(encodedLong(0), sync);
  const prefix = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let headerOffset = 0;
  for (const part of parts) {
    prefix.set(part, headerOffset);
    headerOffset += part.length;
  }
  let nodes = 0;
  let entries = 0;
  const skip = (data: AvroCursor, type: unknown, depth = 0): void => {
    if (++nodes > 200_000 || depth > 24)
      throw new IcebergBudgetError('Avro batch value budget exceeded');
    if (Array.isArray(type)) {
      const index = data.length();
      if (index >= type.length) throw new Error('Invalid Avro union');
      skip(data, type[index], depth + 1);
      return;
    }
    if (object(type)) {
      if (type.type === 'record') {
        for (const field of type.fields as Record<string, unknown>[])
          skip(data, field.type, depth + 1);
        return;
      }
      if (type.type === 'fixed') {
        if (typeof type.size !== 'number' || type.size > 4096)
          throw new Error('Invalid Avro fixed');
        data.take(type.size);
        return;
      }
      if (type.type === 'array' || type.type === 'map') {
        let count = data.long();
        while (count !== 0n) {
          if (count < 0n) {
            count = -count;
            data.length();
          }
          if (count > 4096n || (entries += Number(count)) > 200_000)
            throw new IcebergBudgetError('Avro collection budget exceeded');
          for (let i = 0; i < Number(count); i++) {
            if (type.type === 'map') data.take(data.length());
            skip(data, type.type === 'map' ? type.values : type.items, depth + 1);
          }
          count = data.long();
        }
        return;
      }
      skip(data, type.type, depth + 1);
      return;
    }
    if (type === 'null') return;
    if (type === 'long' || type === 'int') {
      data.long();
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
      data.take(data.length());
      return;
    }
    if (typeof type === 'string' && names.has(type)) {
      skip(data, names.get(type), depth + 1);
      return;
    }
    throw new Error('Unsupported bounded Avro type');
  };
  const pack = (data: Uint8Array, rows: number): Uint8Array => {
    const count = encodedLong(rows);
    const length = encodedLong(data.length);
    const out = new Uint8Array(prefix.length + count.length + length.length + data.length + 16);
    let offset = 0;
    for (const part of [prefix, count, length, data, sync]) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  while (cursor.offset < bytes.length) {
    check();
    const count = cursor.long();
    if (count <= 0n || count > 1_000_000n)
      throw new IcebergBudgetError('Avro block row budget exceeded');
    const compressed = cursor.take(cursor.length());
    if (cursor.take(16).some((b, i) => b !== sync[i])) throw new Error('Avro sync mismatch');
    const data = new AvroCursor(
      codec === 'deflate' ? await boundedDeflate(compressed, check) : compressed
    );
    let start = 0;
    let rows = 0;
    for (let i = 0; i < Number(count); i++) {
      check();
      skip(data, schema);
      rows++;
      if (rows === 32 || i === Number(count) - 1) {
        yield pack(data.bytes.subarray(start, data.offset), rows);
        start = data.offset;
        rows = 0;
        nodes = 0;
        entries = 0;
      }
    }
    if (data.offset !== data.bytes.length) throw new Error('Avro block trailing data');
  }
}

/** Native streaming inflate with an output cap, rather than upstream gunzip's
 * growing output array. Cancellation happens before retaining an excess chunk. */
async function boundedDeflate(input: Uint8Array, check: () => void): Promise<Uint8Array> {
  const maximum = 4 * 1024 * 1024;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      check();
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array) || item.value.length > maximum - length) {
        await reader.cancel();
        throw new IcebergBudgetError('Avro inflated block budget exceeded');
      }
      chunks.push(item.value);
      length += item.value.length;
    }
  } catch (error) {
    await reader.cancel(error);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
