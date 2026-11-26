/** Hand-built bytes for the bounded binary readers: Avro container files and compact Thrift. */

export function zigzagVarint(value: number | bigint): number[] {
  let n = BigInt(value);
  n = n < 0n ? ((-n - 1n) << 1n) | 1n : n << 1n;
  return varint(n);
}

export function varint(value: number | bigint): number[] {
  let n = BigInt(value);
  const out: number[] = [];
  do {
    let byte = Number(n & 127n);
    n >>= 7n;
    if (n > 0n) byte |= 128;
    out.push(byte);
  } while (n > 0n);
  return out;
}

export function text(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

/** An Avro length-prefixed byte string. */
export function avroBytes(bytes: number[]): number[] {
  return [...zigzagVarint(bytes.length), ...bytes];
}

export const SYNC = Array.from({ length: 16 }, (_, i) => 0xa0 + i);

export interface AvroFileOptions {
  schema: unknown;
  /** Extra or replacement header entries, as raw byte values. */
  header?: Record<string, number[]>;
  /** Skip writing the schema entry. */
  noSchema?: boolean;
  /** Blocks of rows: each row is the already encoded bytes of one datum. */
  blocks?: Array<{ rows: number[][]; count?: number; sync?: number[]; extra?: number[] }>;
  magic?: number[];
  /** Write the header map with a negative count and a byte size, in one block. */
  negativeHeader?: boolean;
}

export function avroFile(options: AvroFileOptions): Uint8Array {
  const entries: Array<[string, number[]]> = [];
  if (!options.noSchema) entries.push(['avro.schema', text(JSON.stringify(options.schema))]);
  for (const [key, value] of Object.entries(options.header ?? {})) entries.push([key, value]);
  const body: number[] = [];
  for (const [key, value] of entries) body.push(...avroBytes(text(key)), ...avroBytes(value));
  const out: number[] = [...(options.magic ?? text('Obj\u0001'))];
  if (options.negativeHeader) {
    out.push(...zigzagVarint(-entries.length), ...zigzagVarint(body.length), ...body);
  } else if (entries.length > 0) {
    out.push(...zigzagVarint(entries.length), ...body);
  }
  out.push(...zigzagVarint(0));
  out.push(...SYNC);
  for (const block of options.blocks ?? []) {
    const data = block.rows.flat();
    out.push(
      ...zigzagVarint(block.count ?? block.rows.length),
      ...zigzagVarint(data.length + (block.extra?.length ?? 0)),
      ...data,
      ...(block.extra ?? []),
      ...(block.sync ?? SYNC)
    );
  }
  return Uint8Array.from(out);
}

/** A header map with `count` entries of its own, to exceed the entry budget. */
export function manyEntries(count: number): Record<string, number[]> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, [1]]));
}

/** `count` copies of a byte value. */
export function bytesOf(count: number, value: number): number[] {
  return Array.from({ length: count }, () => value);
}
