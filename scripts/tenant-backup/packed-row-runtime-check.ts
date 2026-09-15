import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  packedSqliteRowToJson,
  sqlitePackedRowExpression,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-packed-row.js';
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const runtime = new Miniflare({
  modules: true,
  script: 'export default {};',
  compatibilityDate: '2026-07-08',
  host: '127.0.0.1',
  d1Databases: ['FIXTURE'],
});
try {
  const db = await runtime.getD1Database('FIXTURE');
  await db.prepare('CREATE TABLE source(id TEXT NOT NULL PRIMARY KEY,value TEXT)').run();
  await db
    .prepare('CREATE TABLE previous(id TEXT NOT NULL PRIMARY KEY,payload BLOB NOT NULL)')
    .run();
  await db
    .prepare(
      `CREATE TRIGGER preserve_previous BEFORE UPDATE ON source BEGIN
    INSERT INTO previous(id,payload) VALUES(OLD.id,${sqlitePackedRowExpression(['id', 'value'], 'OLD')}) ON CONFLICT(id) DO NOTHING; END`
    )
    .run();
  const value = '\u0001'.repeat(1572864);
  await db.prepare('INSERT INTO source VALUES (?,?)').bind('row', value).run();
  await db.prepare('UPDATE source SET value=? WHERE id=?').bind('after', 'row').run();
  const info = await db
    .prepare('SELECT length(payload) AS size FROM previous WHERE id=?')
    .bind('row')
    .first<{ size: number }>();
  assert(info);
  assert(info.size < value.length + 100);
  const packedSize = info.size;
  let fragments = 0;
  async function* source() {
    for (let offset = 0; offset < packedSize; offset += 65536) {
      const row = await db
        .prepare('SELECT hex(substr(payload,?,65536)) AS chunk FROM previous WHERE id=?')
        .bind(offset + 1, 'row')
        .first<{ chunk: string }>();
      assert(row);
      fragments++;
      yield Uint8Array.from(row.chunk.match(/../g) ?? [], (byte) => parseInt(byte, 16));
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let json = '';
  for await (const chunk of packedSqliteRowToJson(source(), ['id', 'value'])) {
    assert(chunk.length <= 262144);
    json += decoder.decode(chunk, { stream: true });
  }
  json += decoder.decode();
  assert.deepEqual(JSON.parse(json), { id: ['text', 'row'], value: ['text', value] });
  assert.equal(
    (await db.prepare('SELECT value FROM source WHERE id=?').bind('row').first<{ value: string }>())
      ?.value,
    'after'
  );
  process.stdout.write(
    JSON.stringify(
      {
        scope: 'local-d1-packed-preimage-fixture',
        passed: true,
        sourceBytes: value.length,
        preimageBytes: info.size,
        portableJsonBytes: json.length,
        fragments,
        productionCaptureIntegration: false,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  await runtime.dispose();
}
