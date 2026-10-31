import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { packedSqliteRowToJson, sqlitePackedRowExpression } from '../sqlite-packed-row';
async function collect(source: AsyncIterable<Uint8Array>) {
  let result = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for await (const chunk of source) {
    expect(chunk.length).toBeLessThanOrEqual(256 * 1024);
    result += decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}
it('preserves null, UTF8, embedded NUL, binary, integer precision and real values', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE example(n,t,b,i,r);');
    const text = '\ufeff界😀\0\n"\\';
    db.prepare("INSERT INTO example VALUES(NULL,?,X'00ff80',9007199254740993,1e999)").run(text);
    const columns = ['n', 't', 'b', 'i', 'r'];
    const row = db
      .prepare(`SELECT ${sqlitePackedRowExpression(columns, 'live')} AS packed FROM example live`)
      .get() as { packed: Uint8Array };
    async function* fragments() {
      for (let i = 0; i < row.packed.length; i++) yield row.packed.slice(i, i + 1);
    }
    expect(JSON.parse(await collect(packedSqliteRowToJson(fragments(), columns)))).toEqual({
      n: ['null', null],
      t: ['text', text],
      b: ['blob', '00FF80'],
      i: ['integer', '9007199254740993'],
      r: ['real', 'Inf'],
    });
  } finally {
    db.close();
  }
});
it('keeps control-character values compact in SQL and escapes bounded chunks in the Worker', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE example(value TEXT);');
    const value = '\u0001'.repeat(1572864);
    db.prepare('INSERT INTO example VALUES(?)').run(value);
    const row = db
      .prepare(`SELECT ${sqlitePackedRowExpression(['value'], 'live')} AS packed FROM example live`)
      .get() as { packed: Uint8Array };
    expect(row.packed.length).toBeLessThan(value.length + 20);
    async function* fragments() {
      for (let i = 0; i < row.packed.length; i += 65536) yield row.packed.slice(i, i + 65536);
    }
    expect(JSON.parse(await collect(packedSqliteRowToJson(fragments(), ['value'])))).toEqual({
      value: ['text', value],
    });
  } finally {
    db.close();
  }
});
it.each(['x1:a', 't2:a', 't1:ab', 'n1:a', 'i1:x', 'r3:NaN', 't99999999999999999:'])(
  'rejects malformed or incomplete packed data %s',
  async (value) => {
    async function* source() {
      yield new TextEncoder().encode(value);
    }
    await expect(collect(packedSqliteRowToJson(source(), ['value']))).rejects.toThrow(
      'snapshot_invalid_packed_row'
    );
  }
);
