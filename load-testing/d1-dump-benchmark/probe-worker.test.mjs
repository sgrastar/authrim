import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import worker from './probe-worker.mjs';

const token = 'synthetic-benchmark-token';

function databaseMock({ result, error } = {}) {
  const calls = [];
  return {
    calls,
    withSession(constraint) {
      calls.push(['withSession', constraint]);
      return {
        prepare(sql) {
          calls.push(['prepare', sql]);
          return {
            async all() {
              calls.push(['all']);
              if (error) throw error;
              return (
                result ?? {
                  success: true,
                  results: [{ present: 1, private_payload: 'never return me' }],
                  meta: {
                    duration: 0.1,
                    timings: { sql_duration_ms: 0.1, unexpected: 'private' },
                    served_by_region: 'APAC',
                    served_by_primary: true,
                    rows_read: 1,
                    rows_written: 0,
                    total_attempts: 1,
                    private_payload: 'never return me',
                  },
                }
              );
            },
          };
        },
      };
    },
  };
}

function environment(source = databaseMock(), control = databaseMock()) {
  return { BENCH_TOKEN: token, DB: source, CONTROL: control };
}

function request(path, { method = 'GET', authorization = `Bearer ${token}` } = {}) {
  const headers = authorization === null ? {} : { Authorization: authorization };
  const value = new Request(`https://benchmark.invalid${path}`, { method, headers });
  Object.defineProperty(value, 'cf', { value: { colo: 'NRT' } });
  return value;
}

test('source read reaches the primary using the indexed probe and returns measurements only', async () => {
  const env = environment();
  const response = await worker.fetch(request('/read?target=source'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.operation, 'read');
  assert.equal(body.target, 'source');
  assert.equal(body.colo, 'NRT');
  assert.equal(typeof body.sqlWallMs, 'number');
  assert.ok(body.sqlWallMs >= 0);
  assert.deepEqual(body.meta, {
    duration: 0.1,
    rows_read: 1,
    rows_written: 0,
    total_attempts: 1,
    served_by_region: 'APAC',
    served_by_primary: true,
    timings: { sql_duration_ms: 0.1 },
  });
  assert.deepEqual(env.DB.calls, [
    ['withSession', 'first-primary'],
    ['prepare', 'SELECT 1 AS present FROM bench_accounts WHERE id = 1'],
    ['all'],
  ]);
  assert.deepEqual(env.CONTROL.calls, []);
  assert.equal(JSON.stringify(body).includes('never return me'), false);
  assert.equal('results' in body, false);
});

test('Workers native timingSafeEqual receives fixed-size SHA-256 digests', async () => {
  const previous = crypto.subtle.timingSafeEqual;
  const lengths = [];
  crypto.subtle.timingSafeEqual = (expected, supplied) => {
    lengths.push([expected.byteLength, supplied.byteLength]);
    return timingSafeEqual(new Uint8Array(expected), new Uint8Array(supplied));
  };
  try {
    const env = environment();
    assert.equal((await worker.fetch(request('/read'), env)).status, 200);
    assert.equal(
      (await worker.fetch(request('/read', { authorization: 'Bearer wrong' }), env)).status,
      401
    );
    assert.deepEqual(lengths, [
      [32, 32],
      [32, 32],
    ]);
    assert.equal(env.DB.calls.length, 3);
  } finally {
    if (previous === undefined) delete crypto.subtle.timingSafeEqual;
    else crypto.subtle.timingSafeEqual = previous;
  }
});

test('control read has no table dependency and cannot touch the source', async () => {
  const env = environment();
  const response = await worker.fetch(request('/read?target=control'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(env.CONTROL.calls, [
    ['withSession', 'first-primary'],
    ['prepare', 'SELECT 1 AS present'],
    ['all'],
  ]);
  assert.deepEqual(env.DB.calls, []);
});

test('source write only increments the dedicated probe row', async () => {
  const env = environment();
  const response = await worker.fetch(request('/write?target=source', { method: 'POST' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(env.DB.calls, [
    ['withSession', 'first-primary'],
    ['prepare', 'UPDATE bench_probe SET writes = writes + 1 WHERE id = 1 RETURNING writes'],
    ['all'],
  ]);
  assert.deepEqual(env.CONTROL.calls, []);
  assert.equal('results' in (await response.json()), false);
});

test('unauthenticated and invalid tokens never inspect either database', async (t) => {
  for (const authorization of [
    null,
    '',
    'Basic abc',
    'Bearer wrong',
    `Bearer ${token}x`,
    `Bearer x${token.slice(1)}`,
    `Bearer ${'a'.repeat(1025)}`,
    `Bearer ${token} extra`,
  ]) {
    await t.test(
      authorization === null ? 'missing header' : authorization.slice(0, 30),
      async () => {
        const env = environment();
        const response = await worker.fetch(
          request('/write', { method: 'POST', authorization }),
          env
        );
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
        assert.deepEqual(env.DB.calls, []);
        assert.deepEqual(env.CONTROL.calls, []);
      }
    );
  }
});

test('authentication runs even for unknown paths and unsupported methods', async () => {
  const env = environment();
  for (const path of ['/seed', '/read', '/write']) {
    const response = await worker.fetch(
      request(path, { method: 'DELETE', authorization: null }),
      env
    );
    assert.equal(response.status, 401);
  }
  assert.deepEqual(env.DB.calls, []);
  assert.deepEqual(env.CONTROL.calls, []);
});

test('missing secret fails closed before any database access', async () => {
  for (const secret of [undefined, '']) {
    const env = { ...environment(), BENCH_TOKEN: secret };
    const response = await worker.fetch(request('/read'), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: 'AUTH_UNAVAILABLE' });
    assert.deepEqual(env.DB.calls, []);
    assert.deepEqual(env.CONTROL.calls, []);
  }
});

test('only explicit read/write routes, methods, and targets are accepted', async (t) => {
  for (const [path, method, status, allow] of [
    ['/seed', 'POST', 404, null],
    ['/read/', 'GET', 404, null],
    ['/read', 'POST', 405, 'GET'],
    ['/write', 'GET', 405, 'POST'],
    ['/read', 'HEAD', 405, 'GET'],
    ['/read?target=other', 'GET', 400, null],
    ['/write?target=control', 'POST', 400, null],
  ]) {
    await t.test(`${method} ${path}`, async () => {
      const env = environment();
      const response = await worker.fetch(request(path, { method }), env);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('Allow'), allow);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(env.DB.calls, []);
      assert.deepEqual(env.CONTROL.calls, []);
    });
  }
});

test('database failure is a sanitized 503 with elapsed time', async () => {
  const source = databaseMock({ error: new Error('secret SQL and private database identifier') });
  const response = await worker.fetch(request('/read'), environment(source));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'D1_UNAVAILABLE');
  assert.equal(body.colo, 'NRT');
  assert.equal(typeof body.sqlWallMs, 'number');
  assert.equal(JSON.stringify(body).includes('secret SQL'), false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('an unsuccessful result and missing probe row fail rather than claiming a usable database', async () => {
  for (const [result, error] of [
    [{ success: false, error: 'private error', results: [] }, 'D1_UNAVAILABLE'],
    [{ success: true, meta: {}, results: [] }, 'PROBE_NOT_READY'],
  ]) {
    const response = await worker.fetch(request('/read'), environment(databaseMock({ result })));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, error);
    assert.equal(JSON.stringify(body).includes('private error'), false);
  }
});
