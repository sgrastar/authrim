import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseAdapter, PreparedStatement } from '../../../db/adapter';
import { TenantBackupImportRequestStore } from '../import-request';
import { TenantBackupOperationKeyStore } from '../operation-key-store';
import { TenantBackupRequestStore } from '../operation-request';
import { createTenantBundleKeyEnvelope } from '../bundle-key-envelope';
import type { TenantBackupStepContext } from '../operation-executor';

let sqlite: DatabaseSync;
let database: Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute' | 'batch'>;
const source = {
  tenantId: 'tenant-a',
  issuer: 'https://tenant.example',
  productVersion: '0.4.2',
};
const selection = {
  settings: true,
  users: false,
  admin: false,
  artifacts: false,
  logs: { audit: false, other: false, sensitive: false, period: 'all' as const },
};

function migrations(...names: string[]) {
  for (const name of names)
    sqlite.exec(
      readFileSync(
        new URL(`../../../../../../migrations/admin/d1/${name}`, import.meta.url),
        'utf8'
      )
    );
}
function adapter(): typeof database {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (sqlite.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      const result = sqlite.prepare(sql).run(...(params as SQLInputValue[]));
      return { success: true, rowsAffected: Number(result.changes) };
    },
    async batch(statements: PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(({ sql, params = [] }) => {
          const result = sqlite.prepare(sql).run(...(params as SQLInputValue[]));
          return { success: true, rowsAffected: Number(result.changes) };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
function uploaded(id: string, idempotencyKey: string, digest: string, expiresAt = 10000) {
  sqlite
    .prepare(
      `INSERT INTO tenant_backup_uploads
       (id,tenant_id,created_by,idempotency_key,expected_bytes,expected_sha256,object_key,multipart_id,
        object_version,object_etag,verified_sha256,completed_at,state,created_at,expires_at)
       VALUES (?,?,?,?,174,?,?,?, ?,?,?,100,'uploaded',0,?)`
    )
    .run(
      id,
      'tenant-a',
      'admin',
      idempotencyKey,
      digest,
      `inputs/${id}`,
      `multipart-${id}`,
      `version-${id}`,
      `etag-${id}`,
      digest,
      expiresAt
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  migrations(
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '005_tenant_backup_key_handoffs.sql',
    '006_tenant_backup_request_intent.sql',
    '008_tenant_backup_retry_state.sql',
    '022_tenant_backup_uploads.sql',
    '023_tenant_backup_operation_inputs.sql'
  );
  database = adapter();
  uploaded('upload-a', 'upload-a-request', 'aa'.repeat(32));
  uploaded('upload-b', 'upload-b-request', 'bb'.repeat(32));
});
afterEach(() => sqlite.close());

it('atomically creates an import request with ordered immutable object identities', async () => {
  const store = new TenantBackupImportRequestStore(database);
  const operation = await store.create({
    id: 'operation-a',
    tenantId: 'tenant-a',
    actorId: 'admin',
    idempotencyKey: 'import-request',
    source,
    selection,
    uploadIds: ['upload-b', 'upload-a'],
    now: 200,
  });
  expect(operation).toMatchObject({ id: 'operation-a', kind: 'import', state: 'waiting' });
  expect(
    sqlite
      .prepare(
        'SELECT ordinal,upload_id,object_key,object_version,object_etag,size_bytes,digest_sha256,bound_at FROM tenant_backup_operation_inputs ORDER BY ordinal'
      )
      .all()
  ).toEqual([
    {
      ordinal: 0,
      upload_id: 'upload-b',
      object_key: 'inputs/upload-b',
      object_version: 'version-upload-b',
      object_etag: 'etag-upload-b',
      size_bytes: 174,
      digest_sha256: 'bb'.repeat(32),
      bound_at: 200,
    },
    {
      ordinal: 1,
      upload_id: 'upload-a',
      object_key: 'inputs/upload-a',
      object_version: 'version-upload-a',
      object_etag: 'etag-upload-a',
      size_bytes: 174,
      digest_sha256: 'aa'.repeat(32),
      bound_at: 200,
    },
  ]);
  expect(() =>
    sqlite.exec("UPDATE tenant_backup_operation_inputs SET object_etag='changed'")
  ).toThrow('immutable');
});

it('returns the same durable request after upload expiry and rejects changed retry intent', async () => {
  const store = new TenantBackupImportRequestStore(database);
  const input = {
    id: 'operation-a',
    tenantId: 'tenant-a',
    actorId: 'admin',
    idempotencyKey: 'import-request',
    source,
    selection,
    uploadIds: ['upload-a'],
    now: 200,
  };
  expect((await store.create(input)).id).toBe('operation-a');
  expect((await store.create({ ...input, id: 'retry-id', now: 20000 })).id).toBe('operation-a');
  await expect(
    store.create({ ...input, selection: { ...selection, users: true }, now: 20000 })
  ).rejects.toThrow('invalid_backup_import_request');
  await expect(store.create({ ...input, actorId: 'other', now: 20000 })).rejects.toThrow(
    'invalid_backup_import_request'
  );
});

it('rejects missing, cross-actor and expired uploads without creating partial operations', async () => {
  const store = new TenantBackupImportRequestStore(database);
  for (const [key, uploadIds, now] of [
    ['missing', ['missing'], 200],
    ['mixed', ['upload-a', 'missing'], 200],
    ['expired', ['upload-a'], 10000],
  ] as const)
    await expect(
      store.create({
        id: `operation-${key}`,
        tenantId: 'tenant-a',
        actorId: 'admin',
        idempotencyKey: key,
        source,
        selection,
        uploadIds: [...uploadIds],
        now,
      })
    ).rejects.toThrow('invalid_backup_import_request');
  await expect(
    store.create({
      id: 'operation-actor',
      tenantId: 'tenant-a',
      actorId: 'other',
      idempotencyKey: 'actor',
      source,
      selection,
      uploadIds: ['upload-a'],
      now: 200,
    })
  ).rejects.toThrow('invalid_backup_import_request');
  expect(
    sqlite.prepare('SELECT count(*) AS total FROM tenant_backup_operations').get()?.total
  ).toBe(0);
});

it('rolls back operation creation when authorization changes before the atomic batch', async () => {
  const base = adapter();
  let first = true;
  const racing = {
    ...base,
    async batch(statements: PreparedStatement[]) {
      if (first) {
        first = false;
        sqlite.exec("UPDATE tenant_backup_uploads SET expires_at=150 WHERE id='upload-a'");
      }
      return base.batch(statements);
    },
  };
  await expect(
    new TenantBackupImportRequestStore(racing).create({
      id: 'operation-race',
      tenantId: 'tenant-a',
      actorId: 'admin',
      idempotencyKey: 'race',
      source,
      selection,
      uploadIds: ['upload-a'],
      now: 200,
    })
  ).rejects.toThrow('invalid_backup_import_request');
  expect(
    sqlite.prepare('SELECT count(*) AS total FROM tenant_backup_operations').get()?.total
  ).toBe(0);
  expect(
    sqlite.prepare('SELECT count(*) AS total FROM tenant_backup_operation_inputs').get()?.total
  ).toBe(0);
});

it('enforces non-null composite input identities in D1 schema', async () => {
  await new TenantBackupImportRequestStore(database).create({
    id: 'operation-a',
    tenantId: 'tenant-a',
    actorId: 'admin',
    idempotencyKey: 'import-request',
    source,
    selection,
    uploadIds: ['upload-a'],
    now: 200,
  });
  expect(() =>
    sqlite.exec(
      "INSERT INTO tenant_backup_operation_inputs(operation_id,tenant_id,ordinal,upload_id,object_key,object_version,object_etag,size_bytes,digest_sha256,bound_at) VALUES('operation-a','tenant-a',NULL,'upload-b','inputs/upload-b','version-upload-b','etag-upload-b',174,'" +
        'bb'.repeat(32) +
        "',200)"
    )
  ).toThrow('NOT NULL');
});

it('binds one accepted content key to each input before starting a multi-bundle import', async () => {
  const imports = new TenantBackupImportRequestStore(database);
  await imports.create({
    id: 'operation-a',
    tenantId: 'tenant-a',
    actorId: 'admin',
    idempotencyKey: 'import-request',
    source,
    selection,
    uploadIds: ['upload-a', 'upload-b'],
    now: 200,
  });
  const wrapping = {
    id: 'wrapping-v1',
    key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  };
  const keys = new TenantBackupOperationKeyStore(database, wrapping);
  async function accept(inputId: string, password: string) {
    const offer = await keys.issue('tenant-a', 'operation-a', 'admin', 201, inputId);
    expect(offer.context.inputId).toBe(inputId);
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      offer.publicKey,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt']
    );
    const opened = await createTenantBundleKeyEnvelope(password, {
      publicKey,
      context: offer.context,
    });
    await keys.accept(
      'tenant-a',
      'operation-a',
      'admin',
      offer.context.challengeId,
      opened.envelope,
      opened.handoff!,
      202
    );
    return offer.context.challengeId;
  }
  const challengeA = await accept('upload-a', 'first durable import password');
  const challengeB = await accept('upload-b', 'second durable import password');
  const requests = new TenantBackupRequestStore(database);
  expect(
    await requests.startImport({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: 'admin',
      revision: 0,
      now: 203,
      challenges: [
        { inputId: 'upload-a', challengeId: challengeB },
        { inputId: 'upload-b', challengeId: challengeA },
      ],
    })
  ).toBeNull();
  expect(
    await requests.startImport({
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      actorId: 'admin',
      revision: 0,
      now: 203,
      challenges: [
        { inputId: 'upload-a', challengeId: challengeA },
        { inputId: 'upload-b', challengeId: challengeB },
      ],
    })
  ).toMatchObject({ state: 'queued', phase: 'prepare', revision: 1 });
  sqlite.exec(
    "UPDATE tenant_backup_operations SET state='running',lease_owner='worker',lease_expires_at=1000 WHERE id='operation-a'"
  );
  const operation = sqlite
    .prepare("SELECT * FROM tenant_backup_operations WHERE id='operation-a'")
    .get();
  const context = {
    operation,
    lease: {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: 1,
    },
    signal: new AbortController().signal,
  } as unknown as TenantBackupStepContext;
  expect(await imports.loadForExecution(context, () => 204)).toMatchObject({
    intent: { kind: 'import', inputs: [{ id: 'upload-a' }, { id: 'upload-b' }] },
    inputs: [
      { inputId: 'upload-a', ordinal: 0, identity: { version: 'version-upload-a' } },
      { inputId: 'upload-b', ordinal: 1, identity: { version: 'version-upload-b' } },
    ],
  });
  const active = await keys.loadActiveInputs(
    {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: 1,
    },
    () => 204
  );
  expect(active.map((item) => item.inputId)).toEqual(['upload-a', 'upload-b']);
  expect(active[0].key.envelope).not.toEqual(active[1].key.envelope);
});
