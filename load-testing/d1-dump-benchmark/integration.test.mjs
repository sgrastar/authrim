import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { schemaSql, seedSql, verificationSql } from './fixture.mjs';

// Resolve exactly the Miniflare installed with this workspace's Wrangler, matching
// scripts/tenant-backup/d1-snapshot-spike.ts. No Wrangler config or cloud API is read.
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = createRequire(
  require.resolve('wrangler/package.json')
)('miniflare');
const token = 'local-integration-benchmark-token';

test('real local D1 bindings execute the probe Worker against the benchmark schema', async (t) => {
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL('./probe-worker.mjs', import.meta.url)),
      compatibilityDate: '2026-10-01',
      host: '127.0.0.1',
      d1Databases: ['DB', 'CONTROL'],
      // This test injects a synthetic local value. Cloud deployments use a Worker secret.
      bindings: { BENCH_TOKEN: token },
    })
  );

  try {
    const source = await runtime.getD1Database('DB');
    const control = await runtime.getD1Database('CONTROL');
    for (const statement of schemaSql
      .split(';')
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await source.prepare(statement).run();
    }
    await source.prepare(seedSql(1, 8, 48)).run();
    const originalAccounts = await source.prepare(verificationSql).first();
    const sample = await source
      .prepare('SELECT email, payload FROM bench_accounts WHERE id = 1')
      .first();
    const readWrites = () =>
      source.prepare('SELECT writes FROM bench_probe WHERE id = 1').first('writes');

    async function dispatch(path, { method = 'GET', authorization = `Bearer ${token}` } = {}) {
      const response = await runtime.dispatchFetch(`https://benchmark.invalid${path}`, {
        method,
        headers: authorization === null ? {} : { Authorization: authorization },
      });
      const text = await response.text();
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(text.includes(sample.email), false);
      assert.equal(text.includes(sample.payload), false);
      const body = JSON.parse(text);
      assert.equal('results' in body, false);
      assert.equal('payload' in body, false);
      assert.equal('writes' in body, false);
      return { response, body };
    }

    await t.test('source read works through a real first-primary D1 session', async () => {
      const { response, body } = await dispatch('/read?target=source');
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.operation, 'read');
      assert.equal(body.target, 'source');
      assert.equal(typeof body.sqlWallMs, 'number');
      assert.ok(body.sqlWallMs >= 0);
      assert.equal(typeof body.meta.rows_read, 'number');
      assert.equal(await readWrites(), 0);
    });

    await t.test(
      'control read works against a separate database with no benchmark tables',
      async () => {
        assert.equal(
          await control
            .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE 'bench_%'")
            .first('count'),
          0
        );
        const { response, body } = await dispatch('/read?target=control');
        assert.equal(response.status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.target, 'control');
        assert.equal(await readWrites(), 0);
      }
    );

    await t.test(
      'missing and incorrect authentication never increment the real counter',
      async () => {
        for (const authorization of [null, 'Basic unrelated', 'Bearer wrong-token']) {
          const { response, body } = await dispatch('/write?target=source', {
            method: 'POST',
            authorization,
          });
          assert.equal(response.status, 401);
          assert.equal(body.error, 'UNAUTHORIZED');
          assert.equal(await readWrites(), 0);
        }
      }
    );

    await t.test('authenticated write updates only the schema-defined writes column', async () => {
      const { response, body } = await dispatch('/write?target=source', { method: 'POST' });
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.operation, 'write');
      assert.equal(await readWrites(), 1);
      assert.deepEqual(await source.prepare(verificationSql).first(), originalAccounts);
    });

    await t.test('unsupported control writes cannot mutate either binding', async () => {
      const { response, body } = await dispatch('/write?target=control', { method: 'POST' });
      assert.equal(response.status, 400);
      assert.equal(body.error, 'INVALID_TARGET');
      assert.equal(await readWrites(), 1);
      assert.deepEqual(await source.prepare(verificationSql).first(), originalAccounts);
    });
  } finally {
    await runtime.dispose();
  }
});
