import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, it, expect } from 'vitest';
import type { DatabaseAdapter } from '../../../db/adapter';
import { TenantBackupRequestStore } from '../operation-request';
import { TenantBackupOperationStore } from '../operation-store';
import { TenantBackupOperationKeyStore } from '../operation-key-store';
import { createTenantBundleKeyEnvelope, deriveTenantBundleStreamKey } from '../bundle-key-envelope';
let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'queryOne' | 'execute'>;
let operations: TenantBackupOperationStore;
let store: TenantBackupOperationKeyStore;
let wrapping: { id: string; key: CryptoKey };
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of [
    '003_tenant_backup_operations.sql',
    '004_tenant_backup_validation_index.sql',
    '005_tenant_backup_key_handoffs.sql',
    '006_tenant_backup_request_intent.sql',
    '007_tenant_backup_active_key.sql',
    '008_tenant_backup_retry_state.sql',
  ])
    db.exec(
      readFileSync(
        new URL('../../../../../../migrations/admin/d1/' + file, import.meta.url),
        'utf8'
      )
    );
  adapter = {
    async queryOne<T>(sql: string, params: unknown[] = []) {
      return (db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
    },
    async execute(sql: string, params: unknown[] = []) {
      return {
        success: true,
        rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
      };
    },
  };
  wrapping = {
    id: 'wrapping-v1',
    key: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  };
  operations = new TenantBackupOperationStore(adapter);
  store = new TenantBackupOperationKeyStore(adapter, wrapping);
  await operations.create({
    id: 'operation-a',
    tenantId: 'tenant-a',
    kind: 'export',
    idempotencyKey: 'request',
    requestDigest: 'ab'.repeat(32),
    actorId: 'admin-a',
    now: 100,
  });
});
afterEach(() => db.close());
async function prepare() {
  const offer = await store.issue('tenant-a', 'operation-a', 'admin-a', 101);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    offer.publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const session = await createTenantBundleKeyEnvelope('fixture backup password for durable key', {
    publicKey,
    context: offer.context,
  });
  expect(session.handoff).toBeDefined();
  return { offer, session };
}
it('accepts once, survives instance restart, and loads only under the current lease', async () => {
  const { offer, session } = await prepare();
  await store.accept(
    'tenant-a',
    'operation-a',
    'admin-a',
    offer.context.challengeId,
    session.envelope,
    session.handoff!,
    102
  );
  await expect(
    store.accept(
      'tenant-a',
      'operation-a',
      'admin-a',
      offer.context.challengeId,
      session.envelope,
      session.handoff!,
      103
    )
  ).rejects.toThrow();
  const run = await operations.claim('tenant-a', 'operation-a', 'worker', 104);
  const lease = {
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    owner: 'worker',
    fencingToken: run!.fencing_token,
  };
  const restarted = new TenantBackupOperationKeyStore(adapter, wrapping);
  await expect(restarted.loadActive(lease, () => 105)).rejects.toThrow();
  const loaded = await restarted.load(lease, offer.context.challengeId, 105);
  const salt = new Uint8Array(32),
    iv = new Uint8Array(12);
  const sourceKey = await deriveTenantBundleStreamKey(session.contentKey, salt);
  const targetKey = await deriveTenantBundleStreamKey(loaded.contentKey, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sourceKey,
    new Uint8Array([7])
  );
  expect(
    new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, targetKey, encrypted))
  ).toEqual(new Uint8Array([7]));
  await expect(
    restarted.load({ ...lease, tenantId: 'tenant-b' }, offer.context.challengeId, 105)
  ).rejects.toThrow();
  await operations.requestCancel('tenant-a', 'operation-a', 106);
  await expect(restarted.load(lease, offer.context.challengeId, 107)).rejects.toThrow();
  expect(await restarted.cleanupPage(107)).toBe(1);
  expect(await restarted.cleanupPage(108)).toBe(0);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('rejects the wrong actor and expires unsubmitted challenges', async () => {
  await expect(store.issue('tenant-a', 'operation-a', 'admin-b', 101)).rejects.toThrow();
  const { offer, session } = await prepare();
  await expect(
    store.accept(
      'tenant-a',
      'operation-a',
      'admin-b',
      offer.context.challengeId,
      session.envelope,
      session.handoff!,
      102
    )
  ).rejects.toThrow();
  await expect(
    store.accept(
      'tenant-a',
      'operation-a',
      'admin-a',
      offer.context.challengeId,
      session.envelope,
      session.handoff!,
      offer.submitExpiresAt
    )
  ).rejects.toThrow();
  expect(await store.cleanupPage(offer.submitExpiresAt)).toBe(1);
});
it('removes the server-side content key as soon as an encrypted operation is ready', async () => {
  const { offer, session } = await prepare();
  await store.accept(
    'tenant-a',
    'operation-a',
    'admin-a',
    offer.context.challengeId,
    session.envelope,
    session.handoff!,
    102
  );
  const operation = await operations.claim('tenant-a', 'operation-a', 'worker', 103);
  const released = await operations.release(
    {
      tenantId: 'tenant-a',
      operationId: 'operation-a',
      owner: 'worker',
      fencingToken: operation!.fencing_token,
    },
    operation!.revision,
    'ready',
    104
  );
  expect(released?.state).toBe('ready');
  expect(await store.cleanupPage(105)).toBe(1);
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_key_handoffs').get()?.n).toBe(0);
});
it('keeps tampered key material pending and authenticates encrypted private storage', async () => {
  const { offer, session } = await prepare();
  const changed = session.handoff!.slice();
  changed[0] ^= 1;
  await expect(
    store.accept(
      'tenant-a',
      'operation-a',
      'admin-a',
      offer.context.challengeId,
      session.envelope,
      changed,
      102
    )
  ).rejects.toThrow();
  expect(db.prepare('SELECT state FROM tenant_backup_key_handoffs').get()).toEqual({
    state: 'pending',
  });
  db.prepare("UPDATE tenant_backup_key_handoffs SET encryption_key_id='different'").run();
  await expect(
    store.accept(
      'tenant-a',
      'operation-a',
      'admin-a',
      offer.context.challengeId,
      session.envelope,
      session.handoff!,
      103
    )
  ).rejects.toThrow();
});
it('rejects cancellation racing the final acceptance write', async () => {
  const { offer, session } = await prepare();
  const racing = {
    ...adapter,
    async queryOne<T>(sql: string, params: unknown[] = []) {
      if (sql.includes("SET state='accepted'"))
        await operations.requestCancel('tenant-a', 'operation-a', 102);
      return adapter.queryOne<T>(sql, params);
    },
  };
  await expect(
    new TenantBackupOperationKeyStore(racing, wrapping).accept(
      'tenant-a',
      'operation-a',
      'admin-a',
      offer.context.challengeId,
      session.envelope,
      session.handoff!,
      102
    )
  ).rejects.toThrow();
  expect(db.prepare('SELECT state FROM tenant_backup_key_handoffs').get()).toEqual({
    state: 'pending',
  });
});
it('bounds active challenges per operation and allows replacement after submission expiry', async () => {
  const offer = await store.issue('tenant-a', 'operation-a', 'admin-a', 101);
  for (let i = 0; i < 31; i++) {
    db.prepare(
      `INSERT INTO tenant_backup_key_handoffs
      (id,tenant_id,operation_id,request_digest,encryption_key_id,private_ciphertext,created_at,submit_expires_at,key_expires_at)
      SELECT ?,tenant_id,operation_id,request_digest,encryption_key_id,private_ciphertext,created_at,submit_expires_at,key_expires_at
      FROM tenant_backup_key_handoffs WHERE id=?`
    ).run('fixture-' + i, offer.context.challengeId);
  }
  await expect(store.issue('tenant-a', 'operation-a', 'admin-a', 102)).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_key_handoffs').get()).toEqual({
    n: 32,
  });
  expect(
    (await store.issue('tenant-a', 'operation-a', 'admin-a', offer.submitExpiresAt)).context
      .challengeId
  ).not.toBe(offer.context.challengeId);
});

it('persists exact request intent atomically and protects retries and database updates', async () => {
  const requests = new TenantBackupRequestStore(adapter);
  const intent = {
    version: 1,
    kind: 'export',
    source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    inputs: [],
  };
  const input = {
    id: 'intent-operation',
    tenantId: 'tenant-a',
    actorId: 'admin-a',
    idempotencyKey: 'intent-request',
    intent,
    now: 101,
  };
  const created = await requests.create(input);
  expect(created).toMatchObject({ state: 'waiting', phase: 'unlock' });
  expect(await operations.claim('tenant-a', created.id, 'worker', 102)).toBeNull();
  expect(await requests.create({ ...input, id: 'retry-id', now: 102 })).toEqual(created);
  expect(await new TenantBackupRequestStore(adapter).load('tenant-a', created.id)).toEqual(intent);
  await expect(requests.load('tenant-b', created.id)).rejects.toThrow();
  await expect(requests.create({ ...input, actorId: 'different' })).rejects.toThrow(/idempotency/);
  intent.selection.users = true;
  await expect(requests.create(input)).rejects.toThrow(/idempotency/);
  expect((await requests.load('tenant-a', created.id)).selection.users).toBe(false);
  expect(() =>
    db.prepare("UPDATE tenant_backup_operations SET request_json='{}' WHERE id=?").run(created.id)
  ).toThrow(/immutable/);
  expect(() =>
    db
      .prepare('UPDATE tenant_backup_operations SET request_digest=? WHERE id=?')
      .run('cd'.repeat(32), created.id)
  ).toThrow(/immutable/);
  await expect(
    requests.create({
      ...input,
      idempotencyKey: 'bad',
      intent: { ...intent, selection: { ...intent.selection, unknown: true } },
    })
  ).rejects.toThrow();
  expect(db.prepare('SELECT count(*) AS n FROM tenant_backup_operations').get()).toEqual({ n: 2 });
});

it('atomically binds only an accepted operation key when leaving unlock', async () => {
  const requests = new TenantBackupRequestStore(adapter);
  const intent = {
    version: 1,
    kind: 'export',
    source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
    selection: {
      settings: true,
      users: false,
      admin: false,
      artifacts: false,
      logs: { audit: false, other: false, sensitive: false, period: 'all' },
    },
    inputs: [],
  };
  const operation = await requests.create({
    id: 'start-operation',
    tenantId: 'tenant-a',
    actorId: 'admin-a',
    idempotencyKey: 'start',
    intent,
    now: 101,
  });
  const offer = await store.issue('tenant-a', operation.id, 'admin-a', 102);
  const start = {
    tenantId: 'tenant-a',
    operationId: operation.id,
    actorId: 'admin-a',
    challengeId: offer.context.challengeId,
    revision: 0,
    now: 104,
  };
  expect(await requests.start(start)).toBeNull();
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    offer.publicKey,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const session = await createTenantBundleKeyEnvelope('fixture password for start gating', {
    publicKey,
    context: offer.context,
  });
  await store.accept(
    'tenant-a',
    operation.id,
    'admin-a',
    offer.context.challengeId,
    session.envelope,
    session.handoff!,
    103
  );
  for (const change of [
    { tenantId: 'tenant-b' },
    { operationId: 'operation-a' },
    { actorId: 'admin-b' },
    { revision: 1 },
    { now: offer.context.expiresAt },
  ])
    expect(await requests.start({ ...start, ...change })).toBeNull();
  expect(await requests.start(start)).toMatchObject({
    state: 'queued',
    phase: 'prepare',
    revision: 1,
    active_key_challenge_id: offer.context.challengeId,
  });
  expect(await requests.start(start)).toBeNull();
  const claimed = await operations.claim('tenant-a', operation.id, 'worker', 105);
  expect(claimed).not.toBeNull();
  const lease = {
    tenantId: 'tenant-a',
    operationId: operation.id,
    owner: 'worker',
    fencingToken: claimed!.fencing_token,
  };
  const active = await new TenantBackupOperationKeyStore(adapter, wrapping).loadActive(
    lease,
    () => 106
  );
  expect(active.envelope).toEqual(session.envelope);
  await expect(store.loadActive({ ...lease, tenantId: 'tenant-b' }, () => 106)).rejects.toThrow();
  await expect(
    store.loadActive({ ...lease, fencingToken: lease.fencingToken - 1 }, () => 106)
  ).rejects.toThrow();
  await expect(store.loadActive(lease, () => offer.context.expiresAt)).rejects.toThrow();
  const context = { operation: claimed!, lease, signal: new AbortController().signal };
  expect(await requests.loadForExecution(context, () => 106)).toEqual(intent);
  for (const change of [
    { revision: claimed!.revision + 1 },
    { phase: 'other' },
    { cursor_json: '{}' },
  ])
    await expect(
      requests.loadForExecution({ ...context, operation: { ...claimed!, ...change } }, () => 106)
    ).rejects.toThrow('execution_fenced');
  await expect(
    requests.loadForExecution({ ...context, lease: { ...lease, owner: 'other' } }, () => 106)
  ).rejects.toThrow('execution_fenced');
  let reads = 0;
  const cancelledDuringDecrypt = new TenantBackupOperationKeyStore(
    {
      ...adapter,
      async queryOne<T>(statement: string, params?: unknown[]) {
        if (statement.includes('SELECT o.active_key_challenge_id') && ++reads === 2)
          await operations.requestCancel('tenant-a', operation.id, 107);
        return adapter.queryOne<T>(statement, params);
      },
    },
    wrapping
  );
  await expect(cancelledDuringDecrypt.loadActive(lease, () => 108)).rejects.toThrow();
  await expect(requests.loadForExecution(context, () => 108)).rejects.toThrow('execution_fenced');
});
