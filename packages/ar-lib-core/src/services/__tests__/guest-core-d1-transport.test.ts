import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createD1Adapter } from '../../db/adapters/d1-adapter';
import { GuestLifecycleRepository } from '../../repositories/guest-lifecycle';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { guestDeletionReceiptFixture } from './guest-deletion-receipt-fixture';
import { guestErasureBoundaryId, parseGuestDeletionReceiptV2 } from '../guest-deletion-receipt';
import { createGuestDeletionProgress } from '../guest-deletion-progress';
import { createAccountLegalHold } from '../../db/account-governance-mutations';
import type { PreparedStatement } from '../../db/adapter';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

async function fixture() {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('miniflare', { paths: [require.resolve('wrangler')] });
  const { Miniflare, convertV4MiniflareOptions } = (await import(
    pathToFileURL(entry).href
  )) as typeof import('miniflare');
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'guest-core-native',
      modules: true,
      script: 'export default {fetch(){return new Response("local-only")}}',
      compatibilityDate: '2026-07-08',
      host: '127.0.0.1',
      cf: false,
      d1Databases: ['GUEST'],
    })
  );
  disposals.push(() => runtime.dispose());
  const db = await runtime.getD1Database('GUEST', 'guest-core-native');
  const host = sqliteAdapter();
  try {
    // Exact final migrated tables/views/constraints, not a permissive mock schema.
    const rows = host.db
      .prepare(
        `SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1
        WHEN 'index' THEN 2 ELSE 3 END,name`
      )
      .all();
    const statements = rows.map((row) => {
      if (typeof row.sql !== 'string') throw new Error('native_schema_sql_missing');
      return row.sql;
    });
    for (let offset = 0; offset < statements.length; offset += 40)
      await db.batch(statements.slice(offset, offset + 40).map((sql) => db.prepare(sql)));
    await db.prepare('INSERT INTO guest_core_mutation_epoch(id,revision) VALUES(1,0)').run();
  } finally {
    host.db.close();
  }
  const route = guestDeletionReceiptFixture();
  const adapter = createD1Adapter(db, 'guest-native');
  await adapter.execute(
    'INSERT INTO tenants(id,tenant_code,tenant_key,name,created_at,updated_at) VALUES(?,?,?,?,1,1)',
    [route.tenantId, route.tenantId, 'fixture-key', 'Fixture']
  );
  await adapter.execute(
    `INSERT INTO identity_accounts(id,tenant_id,account_type,lifecycle_state,legacy_user_id,
    registration_state,directory_publication_state,account_route_generation,created_at,updated_at)
    VALUES(?,?,'user','active',?,'guest','active',1,1,1)`,
    [route.accountId, route.tenantId, route.userId]
  );
  await adapter.execute(
    `INSERT INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,
    deletion_due_at,policy_version,updated_at) VALUES(?,?,?,1,100,'policy:1',1)`,
    [route.tenantId, route.userId, 'app']
  );
  for (const id of ['key-1', 'key-2'])
    await adapter.execute(
      `INSERT INTO passkeys(id,tenant_id,user_id,
    credential_id,public_key,counter,created_at) VALUES(?,?,?,?,?,0,1)`,
      [id, route.tenantId, route.userId, id, 'fixture']
    );
  await adapter.execute(
    'INSERT INTO totp_credentials(id,tenant_id,user_id,secret_encrypted,created_at) VALUES(?,?,?,?,1)',
    ['totp-1', route.tenantId, route.userId, 'fixture']
  );
  await adapter.execute(
    'INSERT INTO totp_backup_codes(id,tenant_id,user_id,code_hash,code_prefix,created_at) VALUES(?,?,?,?,?,1)',
    ['backup-1', route.tenantId, route.userId, 'fixture-hash', 'fixture']
  );
  const repository = new GuestLifecycleRepository(adapter, route.tenantId);
  await repository.admitDeletion({
    userId: route.userId,
    accountId: route.accountId,
    operationId: route.operationId,
    routeJson: JSON.stringify(route),
    expectedRevision: 1,
    accountRouteGeneration: 1,
    now: 2000,
    startedAtMs: 2000000,
    origin: 'admin',
    task: {
      auditId: route.completionAuditId,
      actorUserId: 'fixture-admin',
      ipAddress: 'fixture',
      userAgent: 'fixture',
      metadataJson: '{}',
      createdAt: 2000,
    },
  });
  const started = {
    ...route,
    execution: {
      phase: 'erasure_started' as const,
      boundaryId: await guestErasureBoundaryId(route.operationId),
      erasureStartedAtMs: 2000001,
    },
  };
  const start = () =>
    repository.confirmErasureStart({
      userId: route.userId,
      accountId: route.accountId,
      operationId: route.operationId,
      expectedRevision: 2,
      acceptedRouteJson: JSON.stringify(route),
      erasureStartedRouteJson: JSON.stringify(started),
      accountRouteGeneration: 1,
      now: 2001,
    });
  const hold = () =>
    createAccountLegalHold(adapter, {
      tenantId: route.tenantId,
      accountId: route.accountId,
      holdId: 'hold',
      eventId: 'hold-event',
      operationId: 'hold-event-op',
      actor: 'fixture-admin',
      reasonCode: 'support_case',
      caseReference: null,
      expiresAt: null,
      now: 2000,
    });
  return { db, adapter, repository, route, started, start, hold };
}

it('keeps a hold admitted before erasure through native D1 sessions and production repository SQL', async () => {
  const f = await fixture();
  await f.hold();
  expect((await f.start()).deletion_route_json).toBe(JSON.stringify(f.route));
  expect(
    (await f.adapter.query<{ id: string }>('SELECT id FROM passkeys ORDER BY id')).map((r) => r.id)
  ).toEqual(['key-1', 'key-2']);
  await expect(f.adapter.execute("DELETE FROM passkeys WHERE id='key-1'")).rejects.toThrow();
  await expect(
    f.adapter.execute("DELETE FROM totp_credentials WHERE id='totp-1'")
  ).rejects.toThrow();
  await expect(
    f.adapter.execute("DELETE FROM totp_backup_codes WHERE id='backup-1'")
  ).rejects.toThrow();
  expect(await f.adapter.queryOne('SELECT lifecycle_state FROM identity_accounts')).toEqual({
    lifecycle_state: 'active',
  });
}, 60000);

it('production page repository uses native D1 atomic rollback and primary proof after a lost acknowledgement', async () => {
  const f = await fixture();
  await f.start();
  const routeJson = JSON.stringify(f.started);
  const route = parseGuestDeletionReceiptV2(routeJson, {
    tenantId: f.route.tenantId,
    userId: f.route.userId,
  });
  const progress = {
    ...(await createGuestDeletionProgress(route, [1])),
    stage: 'drain_passkeys' as const,
  };
  const oldJson = JSON.stringify(progress);
  const nextJson = JSON.stringify({
    ...progress,
    revision: progress.revision + 2,
    cursor: 'key-1',
    highWater: 'key-2',
  });
  await f.adapter.execute('UPDATE guest_deletion_audit_outbox SET execution_progress_json=?', [
    oldJson,
  ]);
  const input = {
    routeJson,
    userId: f.route.userId,
    expectedProgressJson: oldJson,
    nextProgressJson: nextJson,
    table: 'passkeys' as const,
    ids: ['key-1'],
  };
  const batch = f.adapter.batch.bind(f.adapter);
  f.adapter.batch = (statements: PreparedStatement[]) =>
    batch([
      ...statements.slice(0, 2),
      { sql: "SELECT json_extract('injected-failure','$.value')" },
      ...statements.slice(2),
    ]);
  try {
    await expect(f.repository.drainCorePage(input)).rejects.toThrow('guest_deletion_page_unknown');
    expect(await f.adapter.query('SELECT id FROM passkeys ORDER BY id')).toEqual([
      { id: 'key-1' },
      { id: 'key-2' },
    ]);
    expect(
      await f.adapter.queryOne('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
    ).toEqual({ execution_progress_json: oldJson });
    f.adapter.batch = async (statements: PreparedStatement[]) => {
      await batch(statements);
      throw new Error('lost_ack');
    };
    expect(await f.repository.drainCorePage(input)).toBe(true);
    expect(await f.adapter.query('SELECT id FROM passkeys ORDER BY id')).toEqual([{ id: 'key-2' }]);
    expect(
      await f.adapter.queryOne('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
    ).toEqual({ execution_progress_json: nextJson });
    await expect(f.adapter.execute("DELETE FROM passkeys WHERE id='key-2'")).rejects.toThrow();
  } finally {
    f.adapter.batch = batch;
  }
}, 60000);

it('native D1 rolls back a partial multi-row erasure and its transient permit, then accepts an exact retry', async () => {
  const f = await fixture();
  await f.start();
  await expect(
    f.adapter.execute('UPDATE guest_account_lifecycle SET deletion_route_json=?', [
      JSON.stringify(f.route),
    ])
  ).rejects.toThrow();
  // The existing governance API uses zero affected rows for a refused admission.
  await f.hold();
  expect(await f.adapter.query("SELECT id FROM legal_holds WHERE state='active'")).toEqual([]);
  for (const sql of [
    "UPDATE guest_account_lifecycle SET user_id='other-user'",
    'DELETE FROM guest_account_lifecycle',
    `INSERT OR REPLACE INTO guest_account_lifecycle(tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at)
      SELECT tenant_id,user_id,client_id,created_at,deletion_due_at,policy_version,updated_at FROM guest_account_lifecycle`,
  ])
    await expect(f.adapter.execute(sql)).rejects.toThrow();
  const progress = {
    ...(await createGuestDeletionProgress(f.started, [1])),
    stage: 'drain_passkeys' as const,
  };
  const original = JSON.stringify(progress);
  const permit = JSON.stringify({ ...progress, corePermit: { table: 'passkeys', ids: ['key-1'] } });
  await f.adapter.execute('UPDATE guest_deletion_audit_outbox SET execution_progress_json=?', [
    original,
  ]);
  const page = (sql: string) => [
    { sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=?', params: [permit] },
    { sql, params: [f.route.tenantId, f.route.userId] },
    { sql: 'UPDATE guest_deletion_audit_outbox SET execution_progress_json=?', params: [original] },
  ];
  await expect(
    f.adapter.batch(page('DELETE FROM passkeys WHERE tenant_id=? AND user_id=?'))
  ).rejects.toThrow();
  expect(await f.adapter.query('SELECT id FROM passkeys ORDER BY id')).toEqual([
    { id: 'key-1' },
    { id: 'key-2' },
  ]);
  expect(
    await f.adapter.queryOne('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
  ).toEqual({ execution_progress_json: original });
  await f.adapter.batch(
    page("DELETE FROM passkeys WHERE tenant_id=? AND user_id=? AND id='key-1'")
  );
  expect(await f.adapter.query('SELECT id FROM passkeys ORDER BY id')).toEqual([{ id: 'key-2' }]);
  expect(
    await f.adapter.queryOne('SELECT execution_progress_json FROM guest_deletion_audit_outbox')
  ).toEqual({ execution_progress_json: original });
  await expect(f.adapter.execute("DELETE FROM passkeys WHERE id='key-2'")).rejects.toThrow();
}, 60000);
