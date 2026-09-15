/** Local snapshot representation; portable artifacts still use typed JSON rows. */
export function sqlitePackedRowExpression(columns: readonly string[], alias: string): string {
  const quote = (name: string) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('snapshot_invalid_identifier');
    return `"${name}"`;
  };
  if (!columns.length || new Set(columns).size !== columns.length)
    throw new Error('snapshot_invalid_columns');
  const sourceAlias = ['OLD', 'NEW'].includes(alias) ? alias : quote(alias);
  const values = columns.map((column) => {
    const value = `${sourceAlias}.${quote(column)}`;
    // Integer and real formatting is identical to the existing typed JSON format.
    const body = `CAST(CASE typeof(${value}) WHEN 'real' THEN printf('%!.17g',${value}) ELSE ifnull(${value},'') END AS BLOB)`;
    return `(CAST(substr(typeof(${value}),1,1)||length(${body})||':' AS BLOB)||${body})`;
  });
  function concatenate(parts: string[]): string {
    if (parts.length === 1) return parts[0];
    const middle = Math.floor(parts.length / 2);
    return `(${concatenate(parts.slice(0, middle))}||${concatenate(parts.slice(middle))})`;
  }
  return `CAST(${concatenate(values)} AS BLOB)`;
}

const encoder = new TextEncoder();
const MAX_OUTPUT = 256 * 1024;
function invalid(): never {
  throw new Error('snapshot_invalid_packed_row');
}

/** Decode a length-prefixed binary row incrementally, escaping text only in the Worker. */
export async function* packedSqliteRowToJson(
  source: AsyncIterable<Uint8Array>,
  columns: readonly string[]
): AsyncGenerator<Uint8Array> {
  if (
    !columns.length ||
    new Set(columns).size !== columns.length ||
    columns.some((column) => !/^[a-z][a-z0-9_]*$/.test(column))
  )
    invalid();
  const iterator = source[Symbol.asyncIterator]();
  let chunk: Uint8Array = new Uint8Array(0),
    offset = 0;
  async function available(): Promise<boolean> {
    while (offset === chunk.length) {
      const next = await iterator.next();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array)) invalid();
      chunk = next.value;
      offset = 0;
    }
    return true;
  }
  function* output(value: string): Generator<Uint8Array> {
    const bytes = encoder.encode(value);
    for (let i = 0; i < bytes.length; i += MAX_OUTPUT) yield bytes.slice(i, i + MAX_OUTPUT);
  }
  try {
    yield* output('{');
    for (let field = 0; field < columns.length; field++) {
      let header = '';
      while (true) {
        if (!(await available())) invalid();
        const byte = chunk[offset++];
        if (byte === 58) break;
        if (header.length >= 18 || byte > 127) invalid();
        header += String.fromCharCode(byte);
      }
      if (!/^[nitrb](0|[1-9][0-9]*)$/.test(header) && !/^t(0|[1-9][0-9]*)$/.test(header)) invalid();
      const type = header[0],
        length = Number(header.slice(1));
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        (type === 'n' && length !== 0) ||
        (['i', 'r'].includes(type) && length > 128)
      )
        invalid();
      const tag = { n: 'null', i: 'integer', r: 'real', t: 'text', b: 'blob' }[type];
      yield* output(
        `${field ? ',' : ''}${JSON.stringify(columns[field])}:["${tag}",${type === 'n' ? 'null' : '"'}`
      );
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      let remaining = length,
        number = '';
      while (remaining > 0) {
        if (!(await available())) invalid();
        const size = Math.min(remaining, chunk.length - offset, MAX_OUTPUT);
        const part = chunk.subarray(offset, offset + size);
        offset += size;
        remaining -= size;
        if (type === 'b')
          yield* output(
            Array.from(part, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join('')
          );
        else if (type === 't')
          yield* output(JSON.stringify(decoder.decode(part, { stream: true })).slice(1, -1));
        else number += decoder.decode(part, { stream: true });
      }
      if (type === 't') yield* output(JSON.stringify(decoder.decode()).slice(1, -1));
      if (type === 'i' || type === 'r') {
        number += decoder.decode();
        if (type === 'i') {
          if (
            !/^(0|-?[1-9][0-9]{0,18})$/.test(number) ||
            BigInt(number) < -(2n ** 63n) ||
            BigInt(number) > 2n ** 63n - 1n
          )
            invalid();
        } else if (
          !['Inf', '-Inf'].includes(number) &&
          (!/^-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(number) ||
            !Number.isFinite(Number(number)))
        )
          invalid();
        yield* output(number);
      }
      yield* output(type === 'n' ? ']' : '"]');
    }
    if (await available()) invalid();
    yield* output('}\n');
  } catch {
    return invalid();
  } finally {
    await iterator.return?.();
  }
}
