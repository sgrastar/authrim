import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { splitMigrationSql } from '../../packages/ar-lib-core/src/services/control-plane/migration-sql.js';
import { sqliteSnapshotStartStatement } from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-capture-plan.js';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  sqliteSnapshotPageQuery,
  sqliteSnapshotTriggers,
} from '../../packages/ar-lib-core/src/services/tenant-portability/sqlite-snapshot.js';

// Feasibility model only. Production assets currently use several catalogs and mutable KV
// references; those writers and cleanup paths are NOT connected to this fixture's protocol.
const schema = {
  table: 'fixture_asset_refs',
  tenantColumn: 'tenant_id',
  columns: ['tenant_id', 'name', 'object_id'],
  primaryKey: ['tenant_id', 'name'],
  uniqueKeys: [],
};
const ddl = `CREATE TABLE fixture_keys (
  tenant_id TEXT NOT NULL,key_id TEXT NOT NULL,key_bytes BLOB,state TEXT NOT NULL CHECK(state IN ('ready','deleted')),
  PRIMARY KEY(tenant_id,key_id), CHECK((state='ready' AND key_bytes IS NOT NULL) OR (state='deleted' AND key_bytes IS NULL)));
  CREATE TABLE fixture_objects (
  tenant_id TEXT NOT NULL, object_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL, content_type TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('uploading','ready','deleting','deleted')),
  key_id TEXT,
  PRIMARY KEY(tenant_id,object_id),FOREIGN KEY(tenant_id,key_id) REFERENCES fixture_keys(tenant_id,key_id));
  CREATE TABLE fixture_asset_refs (
    tenant_id TEXT NOT NULL,name TEXT NOT NULL,object_id TEXT NOT NULL,PRIMARY KEY(tenant_id,name),
    FOREIGN KEY(tenant_id,object_id) REFERENCES fixture_objects(tenant_id,object_id));
  CREATE TRIGGER immutable_object_identity BEFORE UPDATE OF tenant_id,object_id,object_key,sha256,content_type,key_id ON fixture_objects
    BEGIN SELECT RAISE(ABORT,'immutable_object_identity'); END;
  CREATE TRIGGER available_encryption_key BEFORE INSERT ON fixture_objects WHEN NEW.key_id IS NOT NULL BEGIN
    SELECT RAISE(ABORT,'object_key_not_available') WHERE NOT EXISTS(SELECT 1 FROM fixture_keys
      WHERE tenant_id=NEW.tenant_id AND key_id=NEW.key_id AND state='ready'); END;
  CREATE TRIGGER ready_asset_insert BEFORE INSERT ON fixture_asset_refs BEGIN
    SELECT RAISE(ABORT,'object_not_ready') WHERE NOT EXISTS(SELECT 1 FROM fixture_objects
      WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND state='ready'); END;
  CREATE TRIGGER ready_asset_update BEFORE UPDATE ON fixture_asset_refs BEGIN
    SELECT RAISE(ABORT,'object_not_ready') WHERE NOT EXISTS(SELECT 1 FROM fixture_objects
      WHERE tenant_id=NEW.tenant_id AND object_id=NEW.object_id AND state='ready'); END;
  ${SQLITE_SNAPSHOT_SCHEMA} ${sqliteSnapshotTriggers(schema, 'json')}`;
const claimSql = `UPDATE fixture_objects SET state='deleting'
  WHERE tenant_id=? AND object_id=? AND state='ready'
  AND NOT EXISTS(SELECT 1 FROM fixture_asset_refs AS live
    WHERE live.tenant_id=fixture_objects.tenant_id AND live.object_id=fixture_objects.object_id)
  AND NOT EXISTS(SELECT 1 FROM tenant_backup_preimages AS prior
    JOIN tenant_backup_snapshots AS snapshot ON snapshot.id=prior.snapshot_id
    WHERE snapshot.state='capturing' AND snapshot.tenant_id=fixture_objects.tenant_id
      AND prior.source_table='fixture_asset_refs' AND prior.present=1
      AND json_extract(prior.row_json,'$.object_id[1]')=fixture_objects.object_id)
  RETURNING object_key`;
const require = createRequire(import.meta.url);
const { Miniflare } = createRequire(require.resolve('wrangler/package.json'))(
  'miniflare'
) as typeof import('miniflare');
const { buildSync } = createRequire(require.resolve('wrangler/package.json'))(
  'esbuild'
) as typeof import('esbuild');
// Run the actual Worker cryptography in workerd. Do not mix Worker ambient types into the
// Node inventory/setup compiler project, or substitute a test-only encryption implementation.
const cryptoWorker = buildSync({
  stdin: {
    contents: `
  import {encryptLogChunkBody} from './packages/ar-lib-logging/src/chunks/r2-chunk-writer.ts';
  import {decryptLogChunkBody} from './packages/ar-lib-logging/src/chunks/r2-chunk-reader.ts';
  import {rewrapLogChunkObject} from './packages/ar-lib-logging/src/chunks/r2-chunk-rewrap.ts';
  export default {async fetch(request,env) {
    const {action,bytes,options}=await request.json();
    try {
      if(action==='rewrap') {
        await rewrapLogChunkObject({...options,bucket:env.ASSETS,
          from:{...options.from,keyBytes:new Uint8Array(options.from.keyBytes)},
          to:{...options.to,keyBytes:new Uint8Array(options.to.keyBytes)}});
        return Response.json([]);
      }
      const keyBytes=new Uint8Array(options.keyBytes);
      if(action==='encrypt') return Response.json(Array.from(await encryptLogChunkBody(new Uint8Array(bytes),{...options,keyBytes})));
      if(action==='decrypt') return Response.json(Array.from((await decryptLogChunkBody({...options,keyBytes,
        storedBody:typeof bytes==='string'?bytes:new Uint8Array(bytes)})).body));
      return new Response('unknown action',{status:400});
    } catch { return new Response('fixture_crypto_rejected',{status:422}); }
  }};`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
});
const runtime = new Miniflare({
  modules: true,
  script: cryptoWorker.outputFiles[0].text,
  host: '127.0.0.1',
  compatibilityDate: '2026-07-08',
  d1Databases: ['REFERENCE_DB'],
  r2Buckets: ['ASSETS'],
});
const sha256 = (body: string | Uint8Array) => createHash('sha256').update(body).digest('hex');
try {
  const db = await runtime.getD1Database('REFERENCE_DB');
  const bucket = await runtime.getR2Bucket('ASSETS');
  async function cipher(
    action: string,
    bytes: Uint8Array | string,
    options: Record<string, unknown>
  ): Promise<Uint8Array> {
    const response = await runtime.dispatchFetch('http://fixture.local/crypto', {
      method: 'POST',
      body: JSON.stringify({
        action,
        bytes: typeof bytes === 'string' ? bytes : Array.from(bytes),
        options,
      }),
    });
    if (response.status !== 200) throw Error('fixture_crypto_rejected');
    const result: unknown = await response.json();
    assert.ok(
      Array.isArray(result) &&
        result.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    );
    return new Uint8Array(result as number[]);
  }
  function encryptLogChunkBody(
    bytes: Uint8Array,
    options: Record<string, unknown> & { keyBytes: Uint8Array }
  ) {
    return cipher('encrypt', bytes, { ...options, keyBytes: Array.from(options.keyBytes) });
  }
  async function decryptLogChunkBody(
    input: Record<string, unknown> & { storedBody: Uint8Array | string; keyBytes: Uint8Array }
  ) {
    const { storedBody, ...options } = input;
    return {
      body: await cipher('decrypt', storedBody, {
        ...options,
        keyBytes: Array.from(input.keyBytes),
      }),
    };
  }
  function rewrapLogChunkObject(
    input: Record<string, unknown> & {
      from: { keyBytes: Uint8Array; encryptionScope: string; keyVersion: number };
      to: { keyBytes: Uint8Array; encryptionScope: string; keyVersion: number };
    }
  ) {
    return cipher('rewrap', '', {
      ...input,
      from: { ...input.from, keyBytes: Array.from(input.from.keyBytes) },
      to: { ...input.to, keyBytes: Array.from(input.to.keyBytes) },
    });
  }
  await db.batch(splitMigrationSql(ddl).map((sql) => db.prepare(sql)));
  async function upload(
    tenant: string,
    id: string,
    body: string | Uint8Array,
    keyId: string | null = null
  ): Promise<string> {
    const key = `fixture/${tenant}/${id}`;
    const contentType =
      typeof body === 'string' ? 'text/plain' : 'application/authrim.log-chunk+encrypted';
    // Reserve a never-reused object identity before external I/O. Tombstones are retained.
    await db
      .prepare("INSERT INTO fixture_objects VALUES(?,?,?,?,?,'uploading',?)")
      .bind(tenant, id, key, sha256(body), contentType, keyId)
      .run();
    const object = await bucket.put(key, body, {
      onlyIf: { etagDoesNotMatch: '*' },
      sha256: sha256(body),
      httpMetadata: { contentType },
      customMetadata: { tenant, id },
    });
    assert.ok(object, 'conditional creation must succeed only for a fresh key');
    const ready = await db
      .prepare(
        "UPDATE fixture_objects SET state='ready' WHERE tenant_id=? AND object_id=? AND state='uploading'"
      )
      .bind(tenant, id)
      .run();
    assert.equal(ready.meta.changes, 1);
    return key;
  }
  async function reference(tenant: string, name: string, id: string): Promise<void> {
    await db
      .prepare(
        `INSERT INTO fixture_asset_refs VALUES(?,?,?)
      ON CONFLICT(tenant_id,name) DO UPDATE SET object_id=excluded.object_id`
      )
      .bind(tenant, name, id)
      .run();
  }
  async function start(id: string): Promise<void> {
    const start = sqliteSnapshotStartStatement([schema], id, 'a', undefined, 'json');
    assert.equal(
      (
        await db
          .prepare(start.sql)
          .bind(...start.params)
          .run()
      ).meta.changes,
      1
    );
  }
  async function claim(tenant: string, id: string): Promise<string | null> {
    return db.prepare(claimSql).bind(tenant, id).first<string>('object_key');
  }
  async function finishDelete(tenant: string, id: string, key: string): Promise<void> {
    const record = await db
      .prepare(
        "SELECT object_key FROM fixture_objects WHERE tenant_id=? AND object_id=? AND state='deleting'"
      )
      .bind(tenant, id)
      .first<string>('object_key');
    assert.equal(record, key);
    await bucket.delete(key);
    await db
      .prepare(
        "UPDATE fixture_objects SET state='deleted' WHERE tenant_id=? AND object_id=? AND state='deleting'"
      )
      .bind(tenant, id)
      .run();
  }
  async function readAsset(snapshot: string): Promise<string> {
    const active = await db
      .prepare(
        "SELECT id FROM tenant_backup_snapshots WHERE id=? AND tenant_id='a' AND state='capturing'"
      )
      .bind(snapshot)
      .first('id');
    assert.equal(active, snapshot);
    try {
      const page = await db
        .prepare(sqliteSnapshotPageQuery(schema, 'json'))
        .bind(snapshot, 'a', '', 100)
        .all<{ row_json: string }>();
      assert.equal(page.results.length, 1);
      const row = JSON.parse(page.results[0].row_json) as { object_id: [string, string] };
      const record = await db
        .prepare(
          "SELECT object_key,sha256,content_type FROM fixture_objects WHERE tenant_id='a' AND object_id=? AND state='ready'"
        )
        .bind(row.object_id[1])
        .first<{ object_key: string; sha256: string; content_type: string }>();
      if (!record) throw Error('snapshot_object_not_available');
      const body = await bucket.get(record.object_key);
      if (!body) throw Error('snapshot_object_missing');
      const bytes = new Uint8Array(await body.arrayBuffer());
      if (sha256(bytes) !== record.sha256 || body.httpMetadata?.contentType !== record.content_type)
        throw Error('snapshot_object_integrity');
      return new TextDecoder().decode(bytes);
    } catch (error) {
      await db
        .prepare("UPDATE tenant_backup_snapshots SET state='invalid' WHERE id=?")
        .bind(snapshot)
        .run();
      throw error;
    }
  }

  const firstKey = await upload('a', 'v1', 'first image');
  await reference('a', 'logo', 'v1');
  // R2 itself rejects overwriting a retained immutable key through the normal writer option.
  assert.equal(
    await bucket.put(firstKey, 'overwrite', { onlyIf: { etagDoesNotMatch: '*' } }),
    null
  );
  assert.equal(await claim('a', 'v1'), null, 'current reference is protected before any backup');
  await start('first');
  await upload('a', 'v2', 'second image');
  await reference('a', 'logo', 'v2');
  assert.equal(await claim('a', 'v1'), null, 'old reference is protected by COW');
  assert.equal(await readAsset('first'), 'first image');
  await start('second');
  const thirdKey = await upload('a', 'v3', 'third image');
  await reference('a', 'logo', 'v3');
  assert.equal(await readAsset('second'), 'second image');
  // Use the real log-chunk cryptography to retain an old object AND its key through rotation.
  // Raw fixture key bytes are not a production key-storage design.
  const key1 = new Uint8Array(32).fill(11);
  const key2 = new Uint8Array(32).fill(22);
  await db
    .prepare("INSERT INTO fixture_keys VALUES ('a','k1',?,'ready'),('a','k2',?,'ready')")
    .bind(key1.buffer, key2.buffer)
    .run();
  const cryptoContext = {
    tenantKey: 't_fixture',
    logType: 'audit' as const,
    plane: 'archive' as const,
    chunkId: 'chk_fixture',
    compression: 'none' as const,
    encryptionScope: 'tenant:t_fixture:audit:archive',
  };
  const plaintext = new TextEncoder().encode('{"event":"fixture"}\n');
  const encryptedKey1 = 'fixture/a/encrypted-v1';
  const encryptedKey2 = 'fixture/a/encrypted-v2';
  const encrypted1 = await encryptLogChunkBody(plaintext, {
    ...cryptoContext,
    keyBytes: key1,
    keyVersion: 1,
    objectKey: encryptedKey1,
  });
  await upload('a', 'encrypted-v1', encrypted1, 'k1');
  await reference('a', 'logo', 'encrypted-v1');
  await start('encrypted');
  const encrypted2 = await encryptLogChunkBody(plaintext, {
    ...cryptoContext,
    keyBytes: key2,
    keyVersion: 2,
    objectKey: encryptedKey2,
  });
  await upload('a', 'encrypted-v2', encrypted2, 'k2');
  await reference('a', 'logo', 'encrypted-v2');
  async function retireKey(keyId: string): Promise<number> {
    const result = await db
      .prepare(
        `UPDATE fixture_keys SET state='deleted',key_bytes=NULL
      WHERE tenant_id='a' AND key_id=? AND state='ready' AND NOT EXISTS (
        SELECT 1 FROM fixture_objects WHERE tenant_id=fixture_keys.tenant_id AND key_id=fixture_keys.key_id AND state<>'deleted')`
      )
      .bind(keyId)
      .run();
    return result.meta.changes;
  }
  assert.equal(await claim('a', 'encrypted-v1'), null);
  assert.equal(
    await retireKey('k1'),
    0,
    'a pinned encrypted object also retains its decryption key'
  );
  const keyHex = await db
    .prepare(
      "SELECT hex(key_bytes) AS material FROM fixture_keys WHERE tenant_id='a' AND key_id='k1' AND state='ready'"
    )
    .first<string>('material');
  assert.ok(keyHex);
  const storedEncrypted = await readAsset('encrypted');
  const decrypted = await decryptLogChunkBody({
    ...cryptoContext,
    storedBody: storedEncrypted,
    keyBytes: new Uint8Array(Buffer.from(keyHex, 'hex')),
    objectKey: encryptedKey1,
    expectedKeyVersion: 1,
    expectedEncryptionScope: cryptoContext.encryptionScope,
  });
  assert.deepEqual(decrypted.body, plaintext);
  await assert.rejects(
    decryptLogChunkBody({
      ...cryptoContext,
      storedBody: storedEncrypted,
      keyBytes: key2,
      objectKey: encryptedKey1,
      expectedKeyVersion: 1,
    })
  );
  await assert.rejects(
    decryptLogChunkBody({
      ...cryptoContext,
      storedBody: storedEncrypted,
      keyBytes: key1,
      objectKey: encryptedKey2,
      expectedKeyVersion: 1,
    })
  );
  // Characterize the existing rewrap path: it replaces ciphertext at the SAME key. This must
  // change or participate in version preservation before production backup can rely on pins.
  const legacyKey = 'fixture/legacy-rewrap';
  const legacyBody = await encryptLogChunkBody(plaintext, {
    ...cryptoContext,
    keyBytes: key1,
    keyVersion: 1,
    objectKey: legacyKey,
  });
  await bucket.put(legacyKey, legacyBody);
  await rewrapLogChunkObject({
    objectCatalogId: 'fixture',
    objectKey: legacyKey,
    chunkId: cryptoContext.chunkId,
    tenantKey: cryptoContext.tenantKey,
    logType: 'audit',
    plane: 'archive',
    compression: 'none',
    from: { keyBytes: key1, encryptionScope: cryptoContext.encryptionScope, keyVersion: 1 },
    to: { keyBytes: key2, encryptionScope: cryptoContext.encryptionScope, keyVersion: 2 },
  });
  const rewrapped = await bucket.get(legacyKey);
  assert.ok(rewrapped);
  const rewrappedBody = new Uint8Array(await rewrapped.arrayBuffer());
  assert.notEqual(sha256(rewrappedBody), sha256(legacyBody));
  await assert.rejects(
    decryptLogChunkBody({
      ...cryptoContext,
      storedBody: rewrappedBody,
      keyBytes: key1,
      objectKey: legacyKey,
      expectedKeyVersion: 1,
    })
  );
  await db.prepare("DELETE FROM tenant_backup_snapshots WHERE id='encrypted'").run();
  assert.equal(await claim('a', 'encrypted-v1'), encryptedKey1);
  await finishDelete('a', 'encrypted-v1', encryptedKey1);
  assert.equal(await retireKey('k1'), 1);
  await assert.rejects(
    upload('a', 'retired-key-object', encrypted1, 'k1'),
    /object_key_not_available/
  );
  assert.equal(await bucket.get('fixture/a/retired-key-object'), null);
  // Resume the plaintext corruption cases from the currently selected third image.
  await reference('a', 'logo', 'v3');
  assert.equal(await claim('a', 'v2'), null);
  const beforeDenied = await db
    .prepare('SELECT COUNT(*) AS n FROM tenant_backup_preimages')
    .first('n');
  await assert.rejects(reference('b', 'logo', 'v1'), /object_not_ready/);
  assert.equal(
    await db.prepare('SELECT COUNT(*) AS n FROM tenant_backup_preimages').first('n'),
    beforeDenied
  );

  // Deletion claim wins: even before R2 deletion finishes, no writer may reference that key.
  const unusedKey = await upload('a', 'unused', 'not referenced');
  assert.equal(await claim('a', 'unused'), unusedKey);
  await assert.rejects(reference('a', 'logo', 'unused'), /object_not_ready/);
  assert.equal(
    (await bucket.get(unusedKey)) !== null,
    true,
    'simulated interrupted delete retains its body'
  );
  assert.equal(
    await claim('a', 'unused'),
    null,
    'another claimant does not acquire an already claimed row'
  );
  await finishDelete('a', 'unused', unusedKey);
  assert.equal(await bucket.get(unusedKey), null);
  await assert.rejects(upload('a', 'unused', 'reused identity'), /UNIQUE/);
  assert.equal(await bucket.get(unusedKey), null, 'a retired key is never recreated by retry');

  // Reference wins: the claim rechecks references in the same SQL statement.
  await upload('b', 'live', 'foreign current image');
  await reference('b', 'logo', 'live');
  assert.equal(await claim('b', 'live'), null);
  assert.equal(await claim('b', 'v1'), null, 'a claimant cannot cross tenant ownership');
  await db.prepare("DELETE FROM tenant_backup_snapshots WHERE id='first'").run();
  assert.equal(await claim('a', 'v1'), firstKey, 'only the released boundary loses its pin');
  await finishDelete('a', 'v1', firstKey);
  assert.equal(await readAsset('second'), 'second image');

  // Raw external deletion/overwrite can still bypass application coordination. Detect it and
  // invalidate that snapshot instead of treating a missing body as an empty optional asset.
  await start('corrupt');
  await bucket.put(thirdKey, 'fault injection bypasses immutable writer');
  await assert.rejects(readAsset('corrupt'), /snapshot_object_integrity/);
  assert.equal(
    await db.prepare("SELECT state FROM tenant_backup_snapshots WHERE id='corrupt'").first('state'),
    'invalid'
  );
  const missingKey = await upload('a', 'v4', 'fourth image');
  await reference('a', 'logo', 'v4');
  await start('missing');
  await bucket.delete(missingKey);
  await assert.rejects(readAsset('missing'), /snapshot_object_missing/);
  assert.equal(
    await db.prepare("SELECT state FROM tenant_backup_snapshots WHERE id='missing'").first('state'),
    'invalid'
  );
  assert.equal(await readAsset('second'), 'second image');
  process.stdout.write(
    `${JSON.stringify(
      {
        scope: 'local-d1-r2-retention-fixture',
        productionWriterCoverage: false,
        verified: [
          'conditional immutable object creation',
          'current references prevent collection',
          'COW preserves replaced assets',
          'multiple snapshots retain distinct generations',
          'cross-tenant reference denied without capture side effects',
          'atomic delete claim fences new references',
          'interrupted deletion can resume',
          'deleted identity cannot be reused',
          'release one snapshot preserves another',
          'missing body invalidates snapshot',
          'corrupt body invalidates snapshot',
          'encrypted object retention protects old key generation',
          'real log encryption rejects wrong key and changed object AAD',
          'existing same-key rewrap requires a version-preserving writer change',
          'retired key cannot be attached to a new object',
        ],
      },
      null,
      2
    )}\n`
  );
} finally {
  await runtime.dispose();
}
