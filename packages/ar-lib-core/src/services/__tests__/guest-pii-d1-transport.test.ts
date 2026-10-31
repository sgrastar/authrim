import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import { createRequire } from 'node:module';

import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createD1Adapter } from '../../db/adapters/d1-adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { guestDeletionReceiptFixture } from './guest-deletion-receipt-fixture';
import { guestErasureBoundaryId, type GuestErasureSourceReceipt } from '../guest-deletion-receipt';
import { createGuestPiiErasurePort } from '../guest-pii-erasure';
import { splitMigrationSql } from '../control-plane/migration-sql';
import { D1OperationError } from '../../utils/d1-retry';

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
      name: 'guest-pii-native',
      modules: true,
      script: 'export default {fetch(){return new Response("local-only")}}',
      compatibilityDate: '2026-07-08',
      host: '127.0.0.1',
      cf: false,
      d1Databases: ['PII'],
    })
  );
  disposals.push(() => runtime.dispose());
  const db = await runtime.getD1Database('PII', 'guest-pii-native');
  const host = sqliteAdapter('pii');
  try {
    // Prior migrated schema only. Apply migration 014 itself through the production SQL splitter below.
    const rows = host.db
      .prepare(
        `SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
      AND name NOT IN('guest_pii_mutation_epoch','guest_pii_erasure_markers') AND name NOT LIKE 'trg_guest_pii_%' AND name NOT LIKE 'idx_guest_pii_%'
      ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END,name`
      )
      .all();
    const ddl = rows.map((row) => {
      if (typeof row.sql !== 'string') throw Error('native_schema_sql_missing');
      return row.sql;
    });
    for (let offset = 0; offset < ddl.length; offset += 40)
      await db.batch(ddl.slice(offset, offset + 40).map((sql) => db.prepare(sql)));
    const migration = readMigrationSource(
      new URL('../../../../../migrations/pii/d1/', import.meta.url),
      '014_guest_pii_erasure_markers.sql'
    );
    await db.batch(splitMigrationSql(migration).map((sql) => db.prepare(sql)));
  } finally {
    host.db.close();
  }
  const route = guestDeletionReceiptFixture();
  const receipt: GuestErasureSourceReceipt = {
    tenantId: route.tenantId,
    userId: route.userId,
    accountId: route.accountId,
    accountRouteGeneration: route.accountRouteGeneration,
    operationId: route.operationId,
    boundaryId: await guestErasureBoundaryId(route.operationId),
    sourceStartedAtMs: 2000001,
    piiPin: route.piiPin,
  };
  const adapter = createD1Adapter(db, 'guest-pii-native');
  const port = createGuestPiiErasurePort(adapter, receipt.piiPin);
  await adapter.execute(
    'INSERT INTO users_pii(id,tenant_id,email,email_blind_index,created_at,updated_at) VALUES(?,?,?,?,1,1)',
    [receipt.userId, receipt.tenantId, 'private@example.invalid', 'unique-private']
  );
  await adapter.execute(
    `INSERT INTO identity_sensitive_values(id,tenant_id,owner_type,owner_id,value_key,value_json,value_hash,created_at,updated_at) VALUES('sensitive',?,'runtime_user',?,'email','"private@example.invalid"','hash',1,1)`,
    [receipt.tenantId, receipt.userId]
  );
  await adapter.execute(
    `INSERT INTO linked_identities(id,tenant_id,user_id,provider_id,provider_user_id,linked_at) VALUES('linked',?,?,'issuer','subject',1)`,
    [receipt.tenantId, receipt.userId]
  );
  return { db, adapter, port, receipt };
}
async function expectBlocked(action: Promise<unknown>): Promise<void> {
  const error: unknown = await action.then(
    () => null,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(D1OperationError);
  if (!(error instanceof D1OperationError)) throw Error('expected_native_d1_rejection');
  expect(error.cause.message).toContain('guest_pii_erasure_mutation_blocked');
}
it('native Workerd D1 executes migration 014, blocks raw writes/REPLACE and compacts after authorized production-port drain', async () => {
  const f = await fixture();
  let marker = await f.port.start(f.receipt);
  await expectBlocked(f.adapter.execute('DELETE FROM users_pii WHERE id=?', [f.receipt.userId]));
  await expectBlocked(
    f.adapter.execute(
      "INSERT OR REPLACE INTO users_pii(id,tenant_id,email,email_blind_index,created_at,updated_at) VALUES('different-user',?,'other','unique-private',1,1)",
      [f.receipt.tenantId]
    )
  );
  expect(
    await f.adapter.queryOne('SELECT email FROM users_pii WHERE id=?', [f.receipt.userId])
  ).toEqual({ email: 'private@example.invalid' });
  for (const table of await f.port.tables()) {
    const page = await f.port.listPage(f.receipt, { table });
    if (page.keys.length)
      marker = await f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table, keys: page.keys, expectedRevision: marker.revision }
      );
  }
  const terminal = await f.port.complete(
    { ...f.receipt, preparedComplete: true, coreCompleted: true },
    { expectedRevision: marker.revision }
  );
  expect(terminal).toMatchObject({
    state: 'deleted',
    operation_id: null,
    boundary_id: null,
    source_started_at_ms: null,
    permit_table: null,
    permit_keys_json: null,
  });
  expect(await f.adapter.query('SELECT id FROM users_pii')).toEqual([]);
  expect(
    await f.adapter.queryOne(
      'SELECT value_json,value_hash,lifecycle_state FROM identity_sensitive_values'
    )
  ).toEqual({ value_json: null, value_hash: null, lifecycle_state: 'deleted' });
  await expectBlocked(
    f.adapter.execute(
      'INSERT INTO users_pii(id,tenant_id,email,created_at,updated_at) VALUES(?,?,?,1,1)',
      [f.receipt.userId, f.receipt.tenantId, 'late']
    )
  );
}, 60000);

it('native Workerd D1 rolls back the raw DELETE, armed permit and progress if a later page statement fails', async () => {
  const f = await fixture();
  const marker = await f.port.start(f.receipt);
  const batch = f.adapter.batch.bind(f.adapter);
  f.adapter.batch = async (statements) =>
    batch([
      ...statements.slice(0, 3),
      { sql: 'INSERT INTO missing_native_pii_table VALUES(1)' },
      ...statements.slice(3),
    ]);
  await expect(
    f.port.drainPage(
      { ...f.receipt, preparedComplete: true },
      { table: 'users_pii', keys: [f.receipt.userId], expectedRevision: marker.revision }
    )
  ).rejects.toThrow();
  expect(await f.port.get(f.receipt)).toEqual(marker);
  expect(
    await f.adapter.queryOne('SELECT email FROM users_pii WHERE id=?', [f.receipt.userId])
  ).toEqual({ email: 'private@example.invalid' });
  await expectBlocked(f.adapter.execute('DELETE FROM users_pii WHERE id=?', [f.receipt.userId]));
  f.adapter.batch = batch;
  expect(
    (
      await f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table: 'users_pii', keys: [f.receipt.userId], expectedRevision: marker.revision }
      )
    ).revision
  ).toBe(marker.revision + 1);
  expect(await f.adapter.query('SELECT id FROM users_pii')).toEqual([]);
}, 60000);
