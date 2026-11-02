import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import worker, { PART_BYTES, MAX_DUMP_BYTES, MAX_BACKUP_BYTES } from './r2-worker.mjs';

const prefix = 'authrim-dump-r2-test';
const key = `${prefix}/backup.sql`;
const secret = 'test-only-token';
const signedUrl = `https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/db.sql?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=${'a'.repeat(64)}`;
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

// Node's Web Streams lack Workers' known-length type; model its byte-length enforcement.
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(expected) {
    let bytes = 0;
    super({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > expected) throw new Error('too many bytes');
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes !== expected) throw new Error('wrong length');
      },
    });
    this.expectedLength = expected;
  }
};

function object(bytes, etag = hash('md5', bytes)) {
  return {
    size: bytes.byteLength,
    etag,
    uploaded: new Date('2026-10-16T00:00:00Z'),
    body: new Response(bytes).body,
    async text() {
      return new TextDecoder().decode(bytes);
    },
  };
}

function bucketMock() {
  const values = new Map();
  const calls = [];
  let failure;
  return {
    calls,
    values,
    setFailure(value) {
      failure = value;
    },
    async createMultipartUpload(uploadKey, options) {
      calls.push(['create', uploadKey, options]);
      const parts = [];
      return {
        async uploadPart(number, bytes) {
          calls.push(['part', number, bytes.byteLength]);
          if (failure === 'part') throw new Error('secret URL and credentials');
          parts.push(new Uint8Array(bytes));
          return { partNumber: number, etag: `part-${number}` };
        },
        async complete(uploaded) {
          calls.push(['complete', uploaded]);
          if (failure === 'complete') throw new Error('private backend exception');
          const bytes = Buffer.concat(parts);
          values.set(uploadKey, { bytes, etag: `multipart-${parts.length}` });
          return object(bytes, `multipart-${parts.length}`);
        },
        async abort() {
          calls.push(['abort']);
        },
      };
    },
    async put(uploadKey, value) {
      calls.push(['put', uploadKey]);
      const bytes = new TextEncoder().encode(value);
      values.set(uploadKey, { bytes, etag: hash('md5', bytes) });
      return object(bytes);
    },
    async head(uploadKey) {
      calls.push(['head', uploadKey]);
      const value = values.get(uploadKey);
      if (!value) return null;
      return {
        size: value.bytes.byteLength,
        etag: value.etag,
        uploaded: new Date('2026-10-16T00:00:00Z'),
      };
    },
    async get(uploadKey) {
      calls.push(['get', uploadKey]);
      const value = values.get(uploadKey);
      return value ? object(value.bytes, value.etag) : null;
    },
    async delete(keys) {
      calls.push(['delete', keys]);
      for (const item of Array.isArray(keys) ? keys : [keys]) values.delete(item);
    },
  };
}

function dbMock(error) {
  const calls = [];
  return {
    calls,
    withSession(mode) {
      calls.push(['session', mode]);
      return {
        prepare(sql) {
          calls.push(['prepare', sql]);
          return {
            async all() {
              if (error) throw error;
              return {
                success: true,
                results: [{ private: 'never expose' }],
                meta: {
                  duration: 1,
                  timings: { sql_duration_ms: 1 },
                  private: 'secret',
                  served_by_primary: true,
                },
              };
            },
          };
        },
      };
    },
  };
}

function environment() {
  return {
    BENCH_TOKEN: secret,
    RUN_PREFIX: prefix,
    BACKUPS: bucketMock(),
    SOURCE: dbMock(),
    RESTORE: dbMock(),
    CONTROL: dbMock(),
  };
}

function request(path, body, options = {}) {
  const { method = body === undefined ? 'GET' : 'POST', authorization = `Bearer ${secret}` } =
    options;
  return new Request(`https://worker.invalid${path}`, {
    method,
    headers: authorization === null ? {} : { Authorization: authorization },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function events(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /application\/x-ndjson/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function withFetch(mock, callback) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await callback();
  } finally {
    globalThis.fetch = original;
  }
}

function seedBackup(env, bytes) {
  const md5 = hash('md5', bytes);
  env.BACKUPS.values.set(key, { bytes, etag: 'multipart-object' });
  const manifest = {
    key,
    sizeBytes: bytes.byteLength,
    md5,
    sha256: hash('sha256', bytes),
    createdAt: new Date().toISOString(),
    parts: 1,
    objectEtag: 'multipart-object',
  };
  env.BACKUPS.values.set(`${key}.manifest.json`, {
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    etag: 'manifest',
  });
  return { key, uploadUrl: signedUrl, expectedMd5: md5, expectedBytes: bytes.byteLength };
}

test('backup uses uniform 8 MiB parts, durable whole-file hashes, and stored head evidence', async () => {
  const bytes = new Uint8Array(PART_BYTES + 123).fill(73);
  const env = environment();
  await withFetch(
    async (url, options) => {
      assert.equal(url, signedUrl);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers, undefined);
      return new Response(bytes);
    },
    async () => {
      const context = {
        profile: 'authrim-basic',
        schemaSha256: 'b'.repeat(64),
        fingerprintDigest: 'c'.repeat(64),
      };
      const output = await events(
        await worker.fetch(request('/backup', { signedUrl, key, context }), env)
      );
      const final = output.at(-1);
      assert.equal(final.type, 'result');
      assert.equal(final.ok, true);
      assert.equal(final.sizeBytes, bytes.byteLength);
      assert.equal(final.md5, hash('md5', bytes));
      assert.equal(final.sha256, hash('sha256', bytes));
      assert.equal(final.parts, 2);
      assert.deepEqual(
        env.BACKUPS.calls.filter(([action]) => action === 'part'),
        [
          ['part', 1, PART_BYTES],
          ['part', 2, 123],
        ]
      );
      assert.equal(final.head.etag, 'multipart-2');
      assert.notEqual(final.md5, final.head.etag);
      assert.equal(final.manifestKey, `${key}.manifest.json`);
      const manifest = JSON.parse(
        new TextDecoder().decode(env.BACKUPS.values.get(final.manifestKey).bytes)
      );
      assert.equal(manifest.md5, final.md5);
      assert.equal(manifest.sha256, final.sha256);
      assert.equal(manifest.objectEtag, final.head.etag);
      assert.deepEqual(manifest.context, context);
      assert.ok(output.some((event) => event.type === 'progress'));
      assert.equal(JSON.stringify(output).includes('X-Amz-Signature'), false);
    }
  );
});

test('backup aborts unfinished multipart uploads and sanitizes failures', async () => {
  for (const failure of ['part', 'complete']) {
    const env = environment();
    env.BACKUPS.setFailure(failure);
    await withFetch(
      async () => new Response('synthetic sql'),
      async () => {
        const output = await events(
          await worker.fetch(request('/backup', { signedUrl, key }), env)
        );
        assert.equal(output.at(-1).type, 'error');
        assert.equal(output.at(-1).error, 'TRANSFER_UNAVAILABLE');
        assert.ok(env.BACKUPS.calls.some(([action]) => action === 'abort'));
        assert.equal(JSON.stringify(output).includes('secret'), false);
        assert.equal(env.BACKUPS.values.has(`${key}.manifest.json`), false);
      }
    );
  }
});

test('canceling the NDJSON response cancels the source stream and aborts its multipart upload', async () => {
  const env = environment();
  let canceled = false;
  let sent = false;
  let resolveAbort;
  const aborted = new Promise((resolve) => {
    resolveAbort = resolve;
  });
  const create = env.BACKUPS.createMultipartUpload.bind(env.BACKUPS);
  env.BACKUPS.createMultipartUpload = async (...args) => {
    const upload = await create(...args);
    const abort = upload.abort;
    upload.abort = async () => {
      await abort();
      resolveAbort();
    };
    return upload;
  };
  const source = new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(PART_BYTES));
      } else return new Promise(() => {});
    },
    cancel() {
      canceled = true;
    },
  });
  await withFetch(
    async () => new Response(source),
    async () => {
      const response = await worker.fetch(request('/backup', { signedUrl, key }), env);
      const reader = response.body.getReader();
      let text = '';
      while (!text.includes('"type":"progress"')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        text += new TextDecoder().decode(value);
      }
      await reader.cancel();
      await Promise.race([
        aborted,
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('abort did not complete')), 1000).unref();
        }),
      ]);
      assert.equal(canceled, true);
      assert.equal(env.BACKUPS.values.size, 0);
    }
  );
});

test('long transfers emit heartbeat records until a final result or cancellation', async () => {
  const originalInterval = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let tick;
  let cleared = false;
  globalThis.setInterval = (callback, interval) => {
    assert.equal(interval, 10000);
    tick = callback;
    return 777;
  };
  globalThis.clearInterval = (id) => {
    assert.equal(id, 777);
    cleared = true;
  };
  try {
    const source = new ReadableStream({
      pull() {
        return new Promise(() => {});
      },
    });
    await withFetch(
      async () => new Response(source),
      async () => {
        const response = await worker.fetch(request('/backup', { signedUrl, key }), environment());
        const reader = response.body.getReader();
        assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"started"/);
        tick();
        assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"heartbeat"/);
        await reader.cancel();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(cleared, true);
      }
    );
  } finally {
    globalThis.setInterval = originalInterval;
    globalThis.clearInterval = originalClear;
  }
});

test('backup refuses redirects and dumps larger than the SQL import limit', async () => {
  for (const [response, code] of [
    [
      new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } }),
      'EXPORT_DOWNLOAD_FAILED',
    ],
    [
      new Response('short', { headers: { 'Content-Length': String(MAX_BACKUP_BYTES + 1) } }),
      'DUMP_TOO_LARGE',
    ],
  ]) {
    const env = environment();
    await withFetch(
      async () => response,
      async () => {
        const final = (
          await events(await worker.fetch(request('/backup', { signedUrl, key }), env))
        ).at(-1);
        assert.equal(final.error, code);
        assert.deepEqual(env.BACKUPS.calls, []);
      }
    );
  }
});

test('restore streams a known-length body and checks stored manifest, both hashes, and PUT ETag', async () => {
  const bytes = new TextEncoder().encode('CREATE TABLE synthetic (id INTEGER);');
  const env = environment();
  const body = seedBackup(env, bytes);
  await withFetch(
    async (url, options) => {
      assert.equal(url, signedUrl);
      assert.equal(options.method, 'PUT');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['Content-Length'], String(bytes.byteLength));
      const received = new Uint8Array(await new Response(options.body).arrayBuffer());
      assert.deepEqual(received, bytes);
      return new Response(null, { headers: { ETag: `"${body.expectedMd5}"` } });
    },
    async () => {
      const final = (await events(await worker.fetch(request('/restore-upload', body), env))).at(
        -1
      );
      assert.equal(final.type, 'result');
      assert.equal(final.integrityVerified, true);
      assert.equal(final.md5, body.expectedMd5);
      assert.equal(final.sha256, hash('sha256', bytes));
      assert.deepEqual(env.SOURCE.calls, []);
      assert.deepEqual(env.RESTORE.calls, []);
    }
  );
});

test('restore rejects client metadata disagreeing with the durable manifest before any upload', async () => {
  const env = environment();
  const body = seedBackup(env, new Uint8Array([1, 2, 3]));
  body.expectedMd5 = '0'.repeat(32);
  await withFetch(
    async () => {
      assert.fail('must not upload');
    },
    async () => {
      const final = (await events(await worker.fetch(request('/restore-upload', body), env))).at(
        -1
      );
      assert.equal(final.error, 'MANIFEST_MISMATCH');
    }
  );
});

test('prepare-restore keeps raw SQL intact and commits one independently wrapped SQL object', async () => {
  const sql =
    'PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE parent(id INTEGER PRIMARY KEY);\nINSERT INTO parent VALUES(1);\n';
  const env = environment();
  const raw = new TextEncoder().encode(sql);
  const metadata = seedBackup(env, raw);
  const context = {
    profile: 'authrim-core',
    schemaSha256: 'a'.repeat(64),
    fingerprintDigest: 'b'.repeat(64),
  };
  const rawManifest = JSON.parse(
    new TextDecoder().decode(env.BACKUPS.values.get(`${key}.manifest.json`).bytes)
  );
  rawManifest.context = context;
  env.BACKUPS.values.get(`${key}.manifest.json`).bytes = new TextEncoder().encode(
    JSON.stringify(rawManifest)
  );
  await withFetch(
    async () => {
      assert.fail('prepare must use R2 bindings only');
    },
    async () => {
      const output = await events(
        await worker.fetch(
          request('/prepare-restore', {
            key,
            expectedMd5: metadata.expectedMd5,
            expectedBytes: metadata.expectedBytes,
            expectedSha256: hash('sha256', raw),
          }),
          env
        )
      );
      const final = output.at(-1);
      assert.equal(final.type, 'result');
      assert.equal(final.parts.length, 2);
      assert.equal(final.rawMd5, metadata.expectedMd5);
      const prepared = final.parts[0];
      const stored = env.BACKUPS.values.get(prepared.key).bytes;
      assert.equal(
        new TextDecoder().decode(stored),
        `PRAGMA foreign_keys=OFF;\n${sql}\nPRAGMA foreign_keys=ON;\n`
      );
      assert.equal(prepared.sizeBytes, stored.byteLength);
      assert.equal(prepared.md5, hash('md5', stored));
      assert.equal(prepared.sha256, hash('sha256', stored));
      assert.deepEqual(env.BACKUPS.values.get(key).bytes, raw);
      const manifest = JSON.parse(
        new TextDecoder().decode(env.BACKUPS.values.get(prepared.manifestKey).bytes)
      );
      assert.deepEqual(manifest.context, context);
      assert.equal(manifest.preparation.rawSha256, final.rawSha256);
      const index = JSON.parse(
        new TextDecoder().decode(env.BACKUPS.values.get(final.indexKey).bytes)
      );
      assert.deepEqual(index.parts, final.parts);
      const fetchedIndex = await worker.fetch(
        request(`/prepared?prefix=${encodeURIComponent(final.preparedPrefix)}`),
        env
      );
      assert.equal(fetchedIndex.status, 200);
      assert.deepEqual((await fetchedIndex.json()).index.parts, final.parts);
      assert.ok(output.some((event) => event.type === 'progress' && event.key === final.indexKey));
    }
  );
});

test('prepare-restore splits only complete statements and preserves trigger bodies and quoted data', async () => {
  const sql = `-- leading ; comment\nCREATE TABLE records(id INTEGER, value TEXT);\nINSERT INTO records VALUES(1,'日本語; and ''quotes''');\nCREATE TRIGGER keep_value AFTER INSERT ON records BEGIN\n  UPDATE records SET value=CASE WHEN value='x;y' THEN 'a;b' ELSE value END WHERE id=NEW.id;\n  INSERT INTO records VALUES(2,'trigger;body');\nEND;\n/* trailing ; comment */\n`;
  const env = environment();
  const raw = new TextEncoder().encode(sql);
  const metadata = seedBackup(env, raw);
  const final = (
    await events(
      await worker.fetch(
        request('/prepare-restore', {
          key,
          expectedMd5: metadata.expectedMd5,
          expectedBytes: metadata.expectedBytes,
          targetChunkBytes: 70,
        }),
        env
      )
    )
  ).at(-1);
  assert.equal(final.type, 'result');
  assert.ok(final.parts.length > 1);
  let reconstructed = '';
  for (const part of final.parts) {
    if (part.kind === 'foreign-key-finalizer') continue;
    const text = new TextDecoder().decode(env.BACKUPS.values.get(part.key).bytes);
    assert.ok(text.startsWith('PRAGMA foreign_keys=OFF;\n'));
    assert.ok(text.endsWith('\nPRAGMA foreign_keys=ON;\n'));
    reconstructed += text.slice(
      'PRAGMA foreign_keys=OFF;\n'.length,
      -'\nPRAGMA foreign_keys=ON;\n'.length
    );
    if (text.includes('CREATE TRIGGER')) {
      assert.ok(text.includes("INSERT INTO records VALUES(2,'trigger;body');\nEND;"));
    }
  }
  assert.equal(reconstructed, sql);
  assert.equal(
    final.parts.reduce((sum, part) => sum + part.rawBytes, 0),
    raw.byteLength
  );
});

test('prepare-restore appends a separate ON-only finalizer with durable hashes and inherited context', async () => {
  const env = environment();
  const raw = new TextEncoder().encode('CREATE TABLE synthetic(id INTEGER);');
  const metadata = seedBackup(env, raw);
  const rawManifest = JSON.parse(
    new TextDecoder().decode(env.BACKUPS.values.get(`${key}.manifest.json`).bytes)
  );
  rawManifest.context = {
    profile: 'authrim-core',
    schemaSha256: 'b'.repeat(64),
    fingerprintDigest: 'c'.repeat(64),
  };
  env.BACKUPS.values.get(`${key}.manifest.json`).bytes = new TextEncoder().encode(
    JSON.stringify(rawManifest)
  );
  const final = (
    await events(
      await worker.fetch(
        request('/prepare-restore', {
          key,
          expectedMd5: metadata.expectedMd5,
          expectedBytes: metadata.expectedBytes,
        }),
        env
      )
    )
  ).at(-1);
  assert.equal(final.type, 'result');
  const finalizer = final.parts.at(-1);
  const expected = new TextEncoder().encode('PRAGMA foreign_keys=ON;\nSELECT 1;\n');
  assert.equal(finalizer.kind, 'foreign-key-finalizer');
  assert.equal(finalizer.rawBytes, 0);
  assert.equal(finalizer.statements, 2);
  assert.equal(finalizer.key, `${final.preparedPrefix}/0002.sql`);
  assert.equal(finalizer.sizeBytes, expected.byteLength);
  assert.equal(finalizer.head.size, expected.byteLength);
  assert.equal(finalizer.md5, hash('md5', expected));
  assert.equal(finalizer.sha256, hash('sha256', expected));
  assert.deepEqual(new Uint8Array(env.BACKUPS.values.get(finalizer.key).bytes), expected);
  assert.equal(new TextDecoder().decode(expected).includes('foreign_keys=OFF'), false);
  const manifest = JSON.parse(
    new TextDecoder().decode(env.BACKUPS.values.get(finalizer.manifestKey).bytes)
  );
  assert.equal(manifest.kind, 'foreign-key-finalizer');
  assert.deepEqual(manifest.context, rawManifest.context);
  assert.equal(manifest.preparation.foreignKeysDisabled, false);
  assert.equal(manifest.md5, finalizer.md5);
  assert.equal(manifest.sha256, finalizer.sha256);
  const response = await worker.fetch(
    request(`/prepared?prefix=${encodeURIComponent(final.preparedPrefix)}`),
    env
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).index.parts, final.parts);
});

test('prepare-restore rejects enabling foreign_keys and never commits a prepared index', async () => {
  for (const pragma of ['PRAGMA foreign_keys=ON;', 'PRAGMA main.foreign_keys(1);']) {
    const env = environment();
    const raw = new TextEncoder().encode(`${pragma}\nCREATE TABLE synthetic(id INTEGER);`);
    const metadata = seedBackup(env, raw);
    const final = (
      await events(
        await worker.fetch(
          request('/prepare-restore', {
            key,
            expectedMd5: metadata.expectedMd5,
            expectedBytes: metadata.expectedBytes,
          }),
          env
        )
      )
    ).at(-1);
    assert.equal(final.type, 'error');
    assert.equal(final.error, 'FOREIGN_KEYS_ENABLE_UNSUPPORTED');
    assert.equal(env.BACKUPS.values.has(`${key}.restore/index.manifest.json`), false);
    assert.deepEqual(env.BACKUPS.values.get(key).bytes, raw);
  }
});

test('prepare-restore verifies all raw bytes before committing prepared manifests', async () => {
  const env = environment();
  const raw = new TextEncoder().encode(
    "CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES('a');"
  );
  const metadata = seedBackup(env, raw);
  env.BACKUPS.values.get(key).bytes[raw.byteLength - 4] = 'b'.charCodeAt(0);
  const final = (
    await events(
      await worker.fetch(
        request('/prepare-restore', {
          key,
          expectedMd5: metadata.expectedMd5,
          expectedBytes: metadata.expectedBytes,
          targetChunkBytes: 10,
        }),
        env
      )
    )
  ).at(-1);
  assert.equal(final.type, 'error');
  assert.equal(final.error, 'RAW_INTEGRITY_MISMATCH');
  assert.equal(env.BACKUPS.values.has(`${key}.restore/index.manifest.json`), false);
  for (const item of env.BACKUPS.values.keys()) {
    assert.ok(!item.startsWith(`${key}.restore/`) || !item.endsWith('.manifest.json'));
  }
});

function seedPreparedTail(env, sql) {
  const metadata = seedBackup(env, new TextEncoder().encode(sql));
  const manifestObject = env.BACKUPS.values.get(`${key}.manifest.json`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestObject.bytes));
  manifest.preparation = { foreignKeysDisabled: true, rawKey: `${prefix}/original.sql` };
  manifest.context = { profile: 'authrim-core', schemaSha256: 'd'.repeat(64) };
  manifestObject.bytes = new TextEncoder().encode(JSON.stringify(manifest));
  return { ...metadata, populatedTables: ['users_core'] };
}

function unwrappedPart(env, part) {
  const sql = new TextDecoder().decode(env.BACKUPS.values.get(part.key).bytes);
  assert.ok(sql.startsWith('PRAGMA foreign_keys=OFF;\n'));
  assert.ok(sql.endsWith('\nPRAGMA foreign_keys=ON;\n'));
  return sql.slice('PRAGMA foreign_keys=OFF;\n'.length, -'\nPRAGMA foreign_keys=ON;\n'.length);
}

test('prepare-tail preserves SQL order while isolating populated indexes and bounded DDL groups', async () => {
  const env = environment();
  const data = `PRAGMA foreign_keys=OFF;\nCREATE TABLE users_core(id INTEGER,value TEXT);\n${Array.from(
    { length: 8 },
    (_, id) => `INSERT INTO users_core VALUES(${id},'日本語;${id}');\n`
  ).join('')}CREATE TABLE empty_table(id INTEGER);\n`;
  const populated = [
    '-- populated ; comment\nCREATE UNIQUE INDEX "idx one" ON "main"."users_core"(id);',
    '/* index comment */ CREATE INDEX idx_two ON [users_core](value);',
  ];
  const empty = Array.from(
    { length: 17 },
    (_, id) => `CREATE INDEX empty_${id} ON empty_table(id);`
  );
  const triggers = Array.from(
    { length: 17 },
    (_, id) =>
      `CREATE TRIGGER trigger_${id} AFTER INSERT ON empty_table BEGIN UPDATE empty_table SET id=CASE WHEN NEW.id=1 THEN 2 ELSE 3 END; SELECT 'body;statement'; END;`
  );
  const sql = `${data}${populated.join('\n')}\n${empty.join('\n')}\n${triggers.join('\n')}\nPRAGMA foreign_keys=ON;\n`;
  const body = seedPreparedTail(env, sql);
  const originalGet = env.BACKUPS.get.bind(env.BACKUPS);
  env.BACKUPS.get = async (objectKey) => {
    const result = await originalGet(objectKey);
    if (objectKey !== key) return result;
    await result.body.cancel();
    const bytes = env.BACKUPS.values.get(key).bytes;
    let offset = 0;
    result.body = new ReadableStream({
      pull(controller) {
        if (offset === bytes.byteLength) return controller.close();
        const end = Math.min(offset + 7, bytes.byteLength);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
    return result;
  };
  const output = await events(await worker.fetch(request('/prepare-tail', body), env));
  const final = output.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.mode, 'tail-ddl');
  assert.deepEqual(
    final.parts.map((part) => part.kind),
    [
      'data-tail',
      'populated-index',
      'populated-index',
      'empty-indexes',
      'empty-indexes',
      'triggers',
      'triggers',
      'foreign-key-finalizer',
    ]
  );
  const dataParts = final.parts.filter((part) => part.kind !== 'foreign-key-finalizer');
  assert.equal(dataParts.map((part) => unwrappedPart(env, part)).join(''), sql);
  assert.deepEqual(
    dataParts.map((part) => part.statements),
    [11, 1, 1, 16, 1, 16, 2]
  );
  assert.equal(final.rawMd5, body.expectedMd5);
  for (const part of final.parts) {
    const bytes = env.BACKUPS.values.get(part.key).bytes;
    assert.equal(part.md5, hash('md5', bytes));
    assert.equal(part.sha256, hash('sha256', bytes));
    assert.equal(part.sizeBytes, bytes.byteLength);
    const manifest = JSON.parse(
      new TextDecoder().decode(env.BACKUPS.values.get(part.manifestKey).bytes)
    );
    assert.equal(manifest.context.profile, 'authrim-core');
    assert.equal(manifest.preparation.mode, 'tail-ddl');
    assert.equal(manifest.preparation.rawKey, key);
  }
  const index = await worker.fetch(
    request(`/prepared?prefix=${encodeURIComponent(final.preparedPrefix)}`),
    env
  );
  assert.equal(index.status, 200);
  assert.deepEqual((await index.json()).index.parts, final.parts);
  assert.deepEqual(env.SOURCE.calls, []);
  assert.deepEqual(env.RESTORE.calls, []);
});

test('prepare-tail rejects unverified raw inputs, invalid table plans and corrupt SQL before commit', async () => {
  const sql =
    'PRAGMA foreign_keys=OFF;\nCREATE INDEX i ON users_core(id);\nPRAGMA foreign_keys=ON;\n';
  for (const problem of ['raw-manifest', 'hash', 'tables', 'group', 'corrupt']) {
    const env = environment();
    const body = seedPreparedTail(env, sql);
    if (problem === 'raw-manifest') {
      const manifest = env.BACKUPS.values.get(`${key}.manifest.json`);
      const parsed = JSON.parse(new TextDecoder().decode(manifest.bytes));
      delete parsed.preparation;
      manifest.bytes = new TextEncoder().encode(JSON.stringify(parsed));
    } else if (problem === 'hash') body.expectedMd5 = '0'.repeat(32);
    else if (problem === 'tables') body.populatedTables = ['users_core', 'USERS_CORE'];
    else if (problem === 'group') body.emptyIndexGroupSize = 17;
    else env.BACKUPS.values.get(key).bytes[sql.indexOf('(id)') + 1] = 120;
    const response = await worker.fetch(request('/prepare-tail', body), env);
    if (['tables', 'group'].includes(problem)) assert.equal(response.status, 400);
    else {
      const final = (await events(response)).at(-1);
      assert.equal(final.type, 'error');
      assert.equal(
        final.error,
        problem === 'raw-manifest'
          ? 'UNSAFE_TAIL_INPUT'
          : problem === 'hash'
            ? 'MANIFEST_MISMATCH'
            : 'RAW_INTEGRITY_MISMATCH'
      );
    }
    assert.equal(env.BACKUPS.values.has(`${key}.restore/index.manifest.json`), false);
    for (const objectKey of env.BACKUPS.values.keys()) {
      assert.ok(!objectKey.startsWith(`${key}.restore/`) || !objectKey.endsWith('.manifest.json'));
    }
  }
});

test('restore rejects corrupt content and bad returned ETags without ever ingesting', async () => {
  for (const corrupt of [true, false]) {
    const env = environment();
    const body = seedBackup(env, new Uint8Array([1, 2, 3]));
    if (corrupt) env.BACKUPS.values.get(key).bytes[0] = 7;
    await withFetch(
      async (_url, options) => {
        await new Response(options.body).arrayBuffer();
        return new Response(null, { headers: { ETag: '"bad-etag"' } });
      },
      async () => {
        const final = (await events(await worker.fetch(request('/restore-upload', body), env))).at(
          -1
        );
        assert.equal(final.type, 'error');
        assert.equal(final.error, corrupt ? 'RESTORE_INTEGRITY_MISMATCH' : 'RESTORE_ETAG_MISMATCH');
        assert.deepEqual(env.RESTORE.calls, []);
      }
    );
  }
});

test('an upstream PUT error before reading the body cancels the producer without hanging', async () => {
  const env = environment();
  const body = seedBackup(env, new Uint8Array(PART_BYTES + 1));
  await withFetch(
    async () => new Response(null, { status: 503 }),
    async () => {
      const final = (await events(await worker.fetch(request('/restore-upload', body), env))).at(
        -1
      );
      assert.equal(final.error, 'RESTORE_UPLOAD_FAILED');
    }
  );
});

test('strict URL and key validation never reaches storage or external fetch', async () => {
  const invalid = [
    'https://example.com/a',
    signedUrl.replace('https:', 'http:'),
    signedUrl.replace('https://', 'https://user:pass@'),
    signedUrl.replace('.com/', '.com.evil.invalid/'),
    signedUrl.replace('.com/', '.com:8443/'),
    `${signedUrl}#fragment`,
    'https://127.0.0.1/db.sql',
    'https://[::1]/db.sql',
    'https://r2.cloudflarestorage.com/db.sql',
    signedUrl.replace('X-Amz-Signature=', 'Wrong-Signature='),
    signedUrl.replace('https://', 'https://bucket.'),
  ];
  await withFetch(
    async () => {
      assert.fail('must not fetch');
    },
    async () => {
      for (const url of invalid) {
        const env = environment();
        const response = await worker.fetch(request('/backup', { signedUrl: url, key }), env);
        assert.equal(response.status, 400);
        assert.deepEqual(env.BACKUPS.calls, []);
      }
      for (const invalidKey of [
        'other/file.sql',
        `${prefix}-other/file.sql`,
        `${prefix}/../other.sql`,
        `${prefix}/%2e%2e/file.sql`,
        `${prefix}//file.sql`,
      ]) {
        const env = environment();
        assert.equal(
          (await worker.fetch(request('/backup', { signedUrl, key: invalidKey }), env)).status,
          400
        );
        assert.equal(
          (await worker.fetch(request(`/object?key=${encodeURIComponent(invalidKey)}`), env))
            .status,
          400
        );
        assert.deepEqual(env.BACKUPS.calls, []);
      }
    }
  );
});

test('auth applies to every route before storage, fetch, or D1 access', async () => {
  const env = environment();
  await withFetch(
    async () => {
      assert.fail('must not fetch');
    },
    async () => {
      for (const path of [
        '/backup',
        '/restore-upload',
        '/prepare-restore',
        '/prepare-tail',
        '/prepared',
        '/foreign-key-mode',
        '/read',
        '/write',
        '/probe',
        '/object',
        '/unknown',
      ]) {
        const response = await worker.fetch(request(path, undefined, { authorization: null }), env);
        assert.equal(response.status, 401);
        assert.equal(response.headers.get('Cache-Control'), 'no-store');
      }
    }
  );
  assert.deepEqual(env.BACKUPS.calls, []);
  assert.deepEqual(env.SOURCE.calls, []);
  assert.deepEqual(env.CONTROL.calls, []);
});

test('object inspection and deletion stay within the configured prefix', async () => {
  const env = environment();
  seedBackup(env, new Uint8Array([1]));
  const inspect = await worker.fetch(request(`/object?key=${encodeURIComponent(key)}`), env);
  assert.equal(inspect.status, 200);
  const evidence = await inspect.json();
  assert.equal(evidence.head.size, 1);
  assert.equal(evidence.manifest.key, key);
  const removed = await worker.fetch(
    request(`/object?key=${encodeURIComponent(key)}`, undefined, { method: 'DELETE' }),
    env
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(env.BACKUPS.calls.at(-1), ['delete', [key, `${key}.manifest.json`]]);
  assert.equal(env.BACKUPS.values.size, 0);
});

test('primary probes read every target, write only bench_probe, and never expose records', async () => {
  for (const target of ['source', 'restore', 'control']) {
    const env = environment();
    const read = await worker.fetch(request(`/read?target=${target}`), env);
    assert.equal(read.status, 200);
    assert.equal(JSON.stringify(await read.json()).includes('never expose'), false);
    const write = await worker.fetch(
      request(`/probe?target=${target}`, undefined, { method: 'POST' }),
      env
    );
    assert.equal(write.status, 200);
    const db = env[target.toUpperCase()];
    assert.deepEqual(db.calls, [
      ['session', 'first-primary'],
      ['prepare', 'SELECT writes FROM bench_probe WHERE id = 1'],
      ['session', 'first-primary'],
      ['prepare', 'UPDATE bench_probe SET writes = writes + 1 WHERE id = 1 RETURNING writes'],
    ]);
  }
});

test('foreign-key-mode reads the pragma on a fresh primary session for every target', async () => {
  for (const target of ['source', 'restore', 'control']) {
    for (const foreignKeys of [0, 1]) {
      const env = environment();
      const calls = [];
      env[target.toUpperCase()] = {
        withSession(mode) {
          calls.push(['session', mode]);
          return {
            prepare(sql) {
              calls.push(['prepare', sql]);
              return {
                async all() {
                  return {
                    success: true,
                    results: [{ foreign_keys: foreignKeys, private: 'not returned' }],
                  };
                },
              };
            },
          };
        },
      };
      const response = await worker.fetch(request(`/foreign-key-mode?target=${target}`), env);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { ok: true, foreignKeys });
      assert.deepEqual(calls, [
        ['session', 'first-primary'],
        ['prepare', 'PRAGMA foreign_keys'],
      ]);
    }
  }
});

test('foreign-key-mode rejects invalid targets and sanitizes D1 failures', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/foreign-key-mode?target=other'), env)).status, 400);
  assert.deepEqual(env.SOURCE.calls, []);
  assert.deepEqual(env.RESTORE.calls, []);
  assert.deepEqual(env.CONTROL.calls, []);
  env.RESTORE = dbMock(new Error('private database identifier'));
  const response = await worker.fetch(request('/foreign-key-mode?target=restore'), env);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: 'D1_UNAVAILABLE' });
  assert.equal(
    (await worker.fetch(request('/foreign-key-mode', undefined, { method: 'POST' }), env)).status,
    405
  );
});

test('method errors, malformed or oversized bodies, and invalid expected sizes fail closed', async () => {
  const env = environment();
  assert.equal((await worker.fetch(request('/backup'), env)).status, 405);
  assert.equal((await worker.fetch(request('/missing'), env)).status, 404);
  assert.equal(
    (await worker.fetch(request('/backup', { filler: 'x'.repeat(17000) }), env)).status,
    413
  );
  assert.equal(
    (await worker.fetch(request('/backup', { key, signedUrl, context: { token: 'private' } }), env))
      .status,
    400
  );
  for (const expectedBytes of [0, -1, 1.5, MAX_DUMP_BYTES + 1]) {
    const response = await worker.fetch(
      request('/restore-upload', {
        key,
        uploadUrl: signedUrl,
        expectedMd5: 'a'.repeat(32),
        expectedBytes,
      }),
      env
    );
    assert.equal(response.status, 400);
  }
  assert.deepEqual(env.BACKUPS.calls, []);
});
