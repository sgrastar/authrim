import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { sqliteAdapter } from '../../repositories/__tests__/sqlite-core-schema';
import { guestDeletionReceiptFixture } from './guest-deletion-receipt-fixture';
import { guestErasureBoundaryId, type GuestErasureSourceReceipt } from '../guest-deletion-receipt';
import {
  createGuestPiiErasurePort,
  GUEST_PII_ERASURE_TABLES,
  listGuestPiiDeletionMarkers,
  normalizeGuestPiiDeletedMarker,
  prepareRestoredGuestPiiDeletedMarker,
  type GuestPiiErasureTable,
} from '../guest-pii-erasure';

const stores: ReturnType<typeof sqliteAdapter>[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.db.close()));
async function fixture(seedAll = false) {
  const store = sqliteAdapter('pii');
  stores.push(store);
  const route = guestDeletionReceiptFixture();
  const receipt: GuestErasureSourceReceipt = {
    tenantId: route.tenantId,
    userId: route.userId,
    accountId: route.accountId,
    operationId: route.operationId,
    accountRouteGeneration: route.accountRouteGeneration,
    piiPin: route.piiPin,
    boundaryId: await guestErasureBoundaryId(route.operationId),
    sourceStartedAtMs: 2000001,
  };
  const adapter = { ...store.adapter, getType: () => 'd1' } as DatabaseAdapter;
  const port = createGuestPiiErasurePort(adapter, receipt.piiPin);
  const insert = (table: string, row: Record<string, string | number | null>) =>
    store.db
      .prepare(
        `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(row));
  const t = receipt.tenantId,
    u = receipt.userId;
  const rows: Record<GuestPiiErasureTable, Record<string, string | number | null>> = {
    users_pii: {
      id: u,
      tenant_id: t,
      email: 'secret@example.invalid',
      email_blind_index: 'private-index',
      created_at: 1,
      updated_at: 1,
    },
    identity_sensitive_values: {
      id: 'sensitive',
      tenant_id: t,
      owner_type: 'runtime_user',
      owner_id: u,
      value_key: 'email',
      value_json: '"secret@example.invalid"',
      value_hash: 'hash',
      created_at: 1,
      updated_at: 1,
    },
    linked_identities: {
      id: 'linked',
      tenant_id: t,
      user_id: u,
      provider_id: 'issuer',
      provider_user_id: 'subject',
      provider_email: 'secret@example.invalid',
      linked_at: 1,
    },
    subject_identifiers: {
      id: 'identifier',
      tenant_id: t,
      subject_id: u,
      identifier_type: 'email',
      identifier_value: 'secret@example.invalid',
      created_at: 1,
      updated_at: 1,
    },
    pairwise_subject_identifiers: {
      id: 'pairwise',
      tenant_id: t,
      user_id: u,
      client_id: 'client',
      sector_identifier: 'sector',
      subject: 'pairwise-value',
      created_at: 1,
    },
    guest_upgrade_operations: {
      operation_id: 'upgrade',
      tenant_id: t,
      user_id: u,
      client_id: 'client',
      initiating_session_id: 'session',
      request_token_hash: 'a'.repeat(64),
      method: 'email',
      proof_payload_json: '{"secret":true}',
      challenge_verifier: 'b'.repeat(64),
      reservation_publication_json: '{}',
      expires_at: 100,
      created_at: 1,
      updated_at: 1,
    },
    identity_identifier_replacement_challenges: {
      challenge_id: 'challenge',
      tenant_id: t,
      account_id: u,
      identifier_kind: 'email_exact',
      normalized_value_json: '"secret@example.invalid"',
      value_sha256: 'a'.repeat(64),
      otp_verifier: 'b'.repeat(64),
      attempt_limit: 5,
      expires_at: 100,
      initiating_session_ref: 'session',
      recent_reauth_verified_at: 1,
      created_at: 1,
      updated_at: 1,
    },
    identity_identifier_replacement_operations: {
      operation_id: 'replacement',
      tenant_id: t,
      account_id: u,
      identifier_kind: 'email_exact',
      authority: 'admin',
      idempotency_key_sha256: 'a'.repeat(64),
      request_fingerprint_sha256: 'b'.repeat(64),
      outbox_id: 'outbox',
      retry_budget_expires_at: 100,
      created_at: 1,
      updated_at: 1,
    },
    identity_identifier_replacement_history: {
      operation_id: 'replacement',
      old_value_json: '"old@example.invalid"',
      new_value_json: '"secret@example.invalid"',
      old_value_sha256: 'a'.repeat(64),
      new_value_sha256: 'b'.repeat(64),
      normalization_version: 1,
      actor_ref: 'actor',
      authority_evidence_json: '{}',
      verification_evidence_json: '{}',
      created_at: 1,
    },
    identity_identifier_replacement_outbox: {
      outbox_id: 'outbox',
      operation_id: 'replacement',
      tenant_id: t,
      account_id: u,
      event_kind: 'identifier_replacement',
      payload_json: JSON.stringify({
        operationId: 'replacement',
        tenantId: t,
        accountId: u,
        projections: [],
      }),
      created_at: 1,
      updated_at: 1,
    },
    external_identifier_unlink_operations: {
      operation_id: 'unlink',
      tenant_id: t,
      account_id: receipt.accountId,
      user_id: u,
      issuer_json: '"issuer"',
      subject_json: '"subject"',
      issuer_sha256: 'a'.repeat(64),
      subject_sha256: 'b'.repeat(64),
      route_projection_json: '{}',
      created_at: 1,
      updated_at: 1,
    },
    user_anonymization_map: {
      id: 'mapping',
      tenant_id: t,
      user_id: u,
      anonymized_user_id: 'anonymous',
      created_at: 1,
    },
  };
  if (seedAll) for (const table of GUEST_PII_ERASURE_TABLES) insert(table, rows[table]);
  return { ...store, adapter, port, receipt, insert, rows };
}
const primaryKey = (table: GuestPiiErasureTable) =>
  table === 'identity_identifier_replacement_challenges'
    ? 'challenge_id'
    : table === 'identity_identifier_replacement_outbox'
      ? 'outbox_id'
      : table === 'guest_upgrade_operations' ||
          table === 'external_identifier_unlink_operations' ||
          table === 'identity_identifier_replacement_history' ||
          table === 'identity_identifier_replacement_operations'
        ? 'operation_id'
        : 'id';

describe('Guest PII physical source deny and bounded erasure', () => {
  it('never treats the migration sentinel as Guest data to erase', () => {
    expect(GUEST_PII_ERASURE_TABLES).not.toContain('tenant_database_migration_state');
  });

  it('keeps a closed terminal ID marker and blocks new raw data after full authorized drain', async () => {
    const f = await fixture(true);
    let marker = await f.port.start(f.receipt);
    expect(await f.port.tables()).toEqual(GUEST_PII_ERASURE_TABLES);
    await expect(
      f.port.complete(
        { ...f.receipt, preparedComplete: true, coreCompleted: true },
        { expectedRevision: marker.revision }
      )
    ).rejects.toThrow();
    for (const table of GUEST_PII_ERASURE_TABLES) {
      const page = await f.port.listPage(f.receipt, { table });
      expect(page.keys.length, table).toBe(1);
      marker = await f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table, keys: page.keys, expectedRevision: marker.revision }
      );
    }
    marker = await f.port.complete(
      { ...f.receipt, preparedComplete: true, coreCompleted: true },
      { expectedRevision: marker.revision }
    );
    expect(marker).toMatchObject({
      state: 'deleted',
      operation_id: null,
      boundary_id: null,
      source_started_at_ms: null,
      permit_table: null,
      permit_keys_json: null,
    });
    expect(normalizeGuestPiiDeletedMarker(marker)).toEqual(marker);
    expect(await f.port.start(f.receipt)).toEqual(marker);
    expect(() => f.insert('users_pii', f.rows.users_pii)).toThrow(
      'guest_pii_erasure_mutation_blocked'
    );
    // General anonymization remains under its existing lifecycle/TTL, including after Guest deletion.
    f.insert('user_anonymization_map', f.rows.user_anonymization_map);
    f.db.prepare('DELETE FROM user_anonymization_map').run();
    expect(
      f.db
        .prepare('SELECT value_json,value_hash,lifecycle_state FROM identity_sensitive_values')
        .get()
    ).toMatchObject({ value_json: null, value_hash: null, lifecycle_state: 'deleted' });
    expect(
      f.db
        .prepare('SELECT revision FROM service_group_inputs WHERE user_id=?')
        .get(f.receipt.userId)
    ).toBeTruthy();
  });
  it.each(GUEST_PII_ERASURE_TABLES.filter((table) => table !== 'user_anonymization_map'))(
    'freezes direct INSERT/UPDATE/DELETE for %s before capture',
    async (table) => {
      const f = await fixture(true);
      await f.port.start(f.receipt);
      expect(() => f.insert(table, f.rows[table])).toThrow('guest_pii_erasure_mutation_blocked');
      expect(() =>
        f.db.exec(`UPDATE ${table} SET ${primaryKey(table)}=${primaryKey(table)}`)
      ).toThrow('guest_pii_erasure_mutation_blocked');
      expect(() => f.db.exec(`DELETE FROM ${table}`)).toThrow('guest_pii_erasure_mutation_blocked');
    }
  );
  it('blocks OR REPLACE conflicting PK and alternate UNIQUE keys even with recursive triggers disabled', async () => {
    const f = await fixture(true);
    f.db.exec('PRAGMA recursive_triggers=OFF');
    await f.port.start(f.receipt);
    for (const row of [
      { ...f.rows.users_pii, tenant_id: 'foreign', email_blind_index: 'other' },
      { ...f.rows.users_pii, id: 'different-user' },
    ]) {
      const keys = Object.keys(row);
      expect(() =>
        f.db
          .prepare(
            `INSERT OR REPLACE INTO users_pii(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`
          )
          .run(...Object.values(row))
      ).toThrow('guest_pii_erasure_mutation_blocked');
    }
    expect(f.db.prepare('SELECT email FROM users_pii WHERE id=?').get(f.receipt.userId)).toEqual({
      email: 'secret@example.invalid',
    });
  });
  it('does not confuse canonical account IDs, runtime user IDs or tenants', async () => {
    const f = await fixture();
    await f.port.start(f.receipt);
    f.insert('users_pii', {
      ...f.rows.users_pii,
      id: f.receipt.accountId,
      email_blind_index: 'other',
    });
    f.insert('users_pii', { ...f.rows.users_pii, id: 'other-tenant-user', tenant_id: 'foreign' });
    f.insert('identity_sensitive_values', {
      ...f.rows.identity_sensitive_values,
      id: 'account-owned',
      owner_type: 'identity_account',
      owner_id: f.receipt.accountId,
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM users_pii').get()).toEqual({ n: 2 });
  });
  it('rejects changed source pins, operation, generation and unprepared drain/completion', async () => {
    const f = await fixture(true);
    const marker = await f.port.start(f.receipt);
    await expect(
      f.port.get({ ...f.receipt, piiPin: { ...f.receipt.piiPin, databaseId: 'different' } })
    ).rejects.toThrow('source_receipt_invalid');
    await expect(f.port.get({ ...f.receipt, accountRouteGeneration: 2 })).rejects.toThrow(
      'marker_identity_conflict'
    );
    const operationId = 'different-op';
    await expect(
      f.port.get({
        ...f.receipt,
        operationId,
        boundaryId: await guestErasureBoundaryId(operationId),
      })
    ).rejects.toThrow('marker_identity_conflict');
    await expect(
      f.port.drainPage(f.receipt as never, {
        table: 'users_pii',
        keys: [f.receipt.userId],
        expectedRevision: marker.revision,
      })
    ).rejects.toThrow('capture_unconfirmed');
    await expect(
      f.port.complete({ ...f.receipt, preparedComplete: true } as never, {
        expectedRevision: marker.revision,
      })
    ).rejects.toThrow('completion_unconfirmed');
  });
  it('rejects cross-owner page keys and rolls back an armed permit on any failed statement', async () => {
    const f = await fixture(true);
    f.insert('users_pii', { ...f.rows.users_pii, id: 'foreign', email_blind_index: 'other' });
    const marker = await f.port.start(f.receipt);
    await expect(
      f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        {
          table: 'users_pii',
          keys: [f.receipt.userId, 'foreign'],
          expectedRevision: marker.revision,
        }
      )
    ).rejects.toThrow();
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = async (statements) =>
      batch([
        ...statements.slice(0, 3),
        { sql: 'INSERT INTO definitely_missing_table VALUES(1)' },
        ...statements.slice(3),
      ]);
    await expect(
      f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table: 'users_pii', keys: [f.receipt.userId], expectedRevision: marker.revision }
      )
    ).rejects.toThrow();
    expect(await f.port.get(f.receipt)).toEqual(marker);
    expect(f.db.prepare('SELECT id FROM users_pii WHERE id=?').get(f.receipt.userId)).toBeTruthy();
    expect(() => f.db.exec('DELETE FROM users_pii')).toThrow('guest_pii_erasure_mutation_blocked');
  });
  it('guards the revision in SQL when ownership advances after the primary precheck', async () => {
    const f = await fixture(true);
    const marker = await f.port.start(f.receipt);
    const batch = f.adapter.batch.bind(f.adapter);
    let first = true;
    f.adapter.batch = async (statements) => {
      if (first) {
        first = false;
        await batch([
          {
            sql: "UPDATE guest_pii_erasure_markers SET permit_table='linked_identities',permit_keys_json='[\"absent\"]' WHERE tenant_id=? AND user_id=?",
            params: [f.receipt.tenantId, f.receipt.userId],
          },
          {
            sql: 'UPDATE guest_pii_erasure_markers SET permit_table=NULL,permit_keys_json=NULL,revision=revision+1 WHERE tenant_id=? AND user_id=?',
            params: [f.receipt.tenantId, f.receipt.userId],
          },
        ]);
      }
      return batch(statements);
    };
    await expect(
      f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table: 'users_pii', keys: [f.receipt.userId], expectedRevision: marker.revision }
      )
    ).rejects.toThrow();
    expect(f.db.prepare('SELECT email FROM users_pii WHERE id=?').get(f.receipt.userId)).toEqual({
      email: 'secret@example.invalid',
    });
    expect(await f.port.get(f.receipt)).toMatchObject({
      revision: marker.revision + 1,
      permit_table: null,
      permit_keys_json: null,
    });
  });
  it('freezes ownership transfers into or out of the deleted runtime identity', async () => {
    const f = await fixture(true);
    f.insert('linked_identities', {
      ...f.rows.linked_identities,
      id: 'foreign',
      user_id: 'foreign',
      provider_user_id: 'foreign',
    });
    await f.port.start(f.receipt);
    expect(() =>
      f.db
        .prepare("UPDATE linked_identities SET user_id=? WHERE id='foreign'")
        .run(f.receipt.userId)
    ).toThrow('guest_pii_erasure_mutation_blocked');
    expect(() =>
      f.db.exec("UPDATE linked_identities SET user_id='foreign' WHERE id='linked'")
    ).toThrow('guest_pii_erasure_mutation_blocked');
  });
  it('bounds pages and rejects stale revisions before side effects', async () => {
    const f = await fixture();
    for (let i = 0; i < 18; i++)
      f.insert('linked_identities', {
        ...f.rows.linked_identities,
        id: `link-${String(i).padStart(2, '0')}`,
        provider_user_id: `subject-${i}`,
      });
    const marker = await f.port.start(f.receipt);
    const first = await f.port.listPage(f.receipt, { table: 'linked_identities' });
    expect(first.keys).toHaveLength(16);
    expect(first.nextCursor).toBe('link-15');
    expect(first.highWater).toBe('link-17');
    expect(
      (
        await f.port.listPage(f.receipt, {
          table: 'linked_identities',
          cursor: first.nextCursor,
          highWater: first.highWater,
        })
      ).keys
    ).toEqual(['link-16', 'link-17']);
    await expect(
      f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table: 'linked_identities', keys: [...first.keys, 'link-16'], expectedRevision: 1 }
      )
    ).rejects.toThrow('page_budget_exceeded');
    await f.port.drainPage(
      { ...f.receipt, preparedComplete: true },
      { table: 'linked_identities', keys: first.keys, expectedRevision: marker.revision }
    );
    await expect(
      f.port.drainPage(
        { ...f.receipt, preparedComplete: true },
        { table: 'linked_identities', keys: ['link-16'], expectedRevision: marker.revision }
      )
    ).rejects.toThrow('revision_conflict');
  });
  it('pages history by its frozen parent operation keys, including a missing history row', async () => {
    const f = await fixture(true);
    f.insert('identity_identifier_replacement_operations', {
      ...f.rows.identity_identifier_replacement_operations,
      operation_id: 'aaa-no-history',
      outbox_id: 'outbox-absent',
      idempotency_key_sha256: 'c'.repeat(64),
      state: 'canceled',
    });
    let marker = await f.port.start(f.receipt);
    marker = await f.port.drainPage(
      { ...f.receipt, preparedComplete: true },
      {
        table: 'identity_identifier_replacement_operations',
        keys: ['replacement'],
        expectedRevision: marker.revision,
      }
    );
    const first = await f.port.listPage(f.receipt, {
      table: 'identity_identifier_replacement_history',
      limit: 1,
    });
    expect(first).toEqual({
      keys: ['aaa-no-history'],
      nextCursor: 'aaa-no-history',
      highWater: 'replacement',
    });
    marker = await f.port.drainPage(
      { ...f.receipt, preparedComplete: true },
      {
        table: 'identity_identifier_replacement_history',
        keys: first.keys,
        expectedRevision: marker.revision,
      }
    );
    const second = await f.port.listPage(f.receipt, {
      table: 'identity_identifier_replacement_history',
      limit: 1,
      cursor: first.nextCursor,
      highWater: first.highWater,
    });
    expect(second).toEqual({ keys: ['replacement'], nextCursor: null, highWater: 'replacement' });
    await f.port.drainPage(
      { ...f.receipt, preparedComplete: true },
      {
        table: 'identity_identifier_replacement_history',
        keys: second.keys,
        expectedRevision: marker.revision,
      }
    );
    expect(
      f.db
        .prepare(
          "SELECT old_value_json,new_value_json,raw_values_erased_at FROM identity_identifier_replacement_history WHERE operation_id='replacement'"
        )
        .get()
    ).toEqual({ old_value_json: null, new_value_json: null, raw_values_erased_at: 2000 });
  });
  it('uses ordered owner/PK index reads for every high-water and keyset query', async () => {
    const f = await fixture(true);
    await f.port.start(f.receipt);
    const query = vi.spyOn(f.adapter, 'query'),
      queryOne = vi.spyOn(f.adapter, 'queryOne');
    const expected: Record<string, string> = {
      identity_sensitive_values: 'sensitive',
      linked_identities: 'linked',
      subject_identifiers: 'subject',
      pairwise_subject_identifiers: 'pairwise',
      guest_upgrade_operations: 'upgrade',
      identity_identifier_replacement_challenges: 'replacement_challenge',
      identity_identifier_replacement_operations: 'replacement_operation',
      identity_identifier_replacement_history: 'replacement_operation',
      identity_identifier_replacement_outbox: 'replacement_outbox',
      external_identifier_unlink_operations: 'unlink',
    };
    for (const table of GUEST_PII_ERASURE_TABLES) {
      query.mockClear();
      queryOne.mockClear();
      await f.port.listPage(f.receipt, { table, cursor: '!' });
      const statements = [...queryOne.mock.calls, ...query.mock.calls].filter(
        ([sql]) => sql.includes(' AS high_water') || sql.includes(' AS id FROM')
      );
      expect(statements, table).toHaveLength(2);
      for (const [sql, params] of statements) {
        const values = (params ?? []).map((value) => {
          if (value === null || typeof value === 'string' || typeof value === 'number')
            return value;
          throw Error('invalid query plan fixture value');
        });
        const details = f.db
          .prepare('EXPLAIN QUERY PLAN ' + sql)
          .all(...values)
          .map((row) => String(row.detail));
        expect(
          details.some((detail) => /SCAN (?:source|owner)\b|USE TEMP B-TREE/u.test(detail)),
          table + ': ' + details.join(';')
        ).toBe(false);
        if (expected[table])
          expect(
            details.some((detail) => detail.includes(`idx_guest_pii_${expected[table]}_drain`)),
            table + ': ' + details.join(';')
          ).toBe(true);
      }
    }
  });
  it('proves completion from the owner operation index instead of scanning unrelated history', async () => {
    const f = await fixture(true);
    const marker = await f.port.start(f.receipt);
    const batch = vi.spyOn(f.adapter, 'batch');
    await expect(
      f.port.complete(
        { ...f.receipt, preparedComplete: true, coreCompleted: true },
        { expectedRevision: marker.revision }
      )
    ).rejects.toThrow();
    const guard = batch.mock.calls.at(-1)?.[0][0];
    if (!guard) throw Error('missing completion guard');
    const values = (guard.params ?? []).map((value) => {
      if (value === null || typeof value === 'string' || typeof value === 'number') return value;
      throw Error('invalid query plan fixture value');
    });
    const details = f.db
      .prepare('EXPLAIN QUERY PLAN ' + guard.sql)
      .all(...values)
      .map((row) => String(row.detail));
    expect(
      details.some((detail) => /SCAN (?:source|owner)\b|USE TEMP B-TREE/u.test(detail)),
      details.join(';')
    ).toBe(false);
    expect(
      details.some((detail) =>
        detail.includes(
          'SEARCH owner USING COVERING INDEX idx_guest_pii_replacement_operation_drain'
        )
      ),
      details.join(';')
    ).toBe(true);
  });
  it('cannot delete, replace, reopen or change a marker; invalid nullable start is rejected', async () => {
    const f = await fixture();
    await f.port.start(f.receipt);
    for (const sql of [
      'DELETE FROM guest_pii_erasure_markers',
      "UPDATE guest_pii_erasure_markers SET state='deleted'",
      'UPDATE guest_pii_erasure_markers SET account_route_generation=2',
      'DELETE FROM guest_pii_mutation_epoch',
      'UPDATE guest_pii_mutation_epoch SET revision=0',
    ])
      expect(() => f.db.exec(sql)).toThrow();
    expect(() =>
      f.db.exec(
        'INSERT OR REPLACE INTO guest_pii_erasure_markers SELECT * FROM guest_pii_erasure_markers'
      )
    ).toThrow('guest_pii_marker_identity_conflict');
    expect(() =>
      f.db
        .prepare(
          "INSERT INTO guest_pii_erasure_markers(schema_version,tenant_id,user_id,account_id,account_route_generation,state,revision) VALUES(1,'x','x','x',1,'erasing',1)"
        )
        .run()
    ).toThrow();
  });
  it('shares only schema preflight inside one admitted invocation while checking live epoch each method', async () => {
    const f = await fixture();
    const query = vi.spyOn(f.adapter, 'query');
    const queryOne = vi.spyOn(f.adapter, 'queryOne');
    await f.port.tables();
    const marker = await f.port.start(f.receipt);
    await f.port.get(f.receipt);
    await f.port.listPage(f.receipt, { table: 'users_pii' });
    await f.port.complete(
      { ...f.receipt, preparedComplete: true, coreCompleted: true },
      { expectedRevision: marker.revision }
    );
    expect(query.mock.calls.filter(([sql]) => sql.includes('sqlite_master'))).toHaveLength(1);
    expect(
      queryOne.mock.calls.filter(
        ([sql]) => sql === 'SELECT revision FROM guest_pii_mutation_epoch WHERE id=1'
      )
    ).toHaveLength(5);
    await createGuestPiiErasurePort(f.adapter, f.receipt.piiPin).tables();
    expect(query.mock.calls.filter(([sql]) => sql.includes('sqlite_master'))).toHaveLength(2);
  });
  it('caches a schema rejection only for that invocation; a new port performs its own validation', async () => {
    const f = await fixture();
    const ddl = f.db
      .prepare("SELECT sql FROM sqlite_master WHERE name='trg_guest_pii_users_pii_delete'")
      .get()?.sql;
    if (typeof ddl !== 'string') throw Error('missing fixture guard');
    f.db.exec('DROP TRIGGER trg_guest_pii_users_pii_delete');
    const query = vi.spyOn(f.adapter, 'query');
    await expect(f.port.start(f.receipt)).rejects.toThrow('schema_unsupported');
    f.db.exec(ddl);
    await expect(f.port.start(f.receipt)).rejects.toThrow('schema_unsupported');
    expect(query.mock.calls.filter(([sql]) => sql.includes('sqlite_master'))).toHaveLength(1);
    expect(
      (await createGuestPiiErasurePort(f.adapter, f.receipt.piiPin).start(f.receipt)).state
    ).toBe('erasing');
  });
  it('fails closed when a physical guard is missing and recovers a positively committed start after lost acknowledgement', async () => {
    const f = await fixture();
    const batch = f.adapter.batch.bind(f.adapter);
    f.adapter.batch = async (statements) => {
      await batch(statements);
      throw Error('lost-ack');
    };
    expect((await f.port.start(f.receipt)).state).toBe('erasing');
    f.db.exec('DROP TRIGGER trg_guest_pii_users_pii_delete');
    await expect(
      createGuestPiiErasurePort(f.adapter, f.receipt.piiPin).get(f.receipt)
    ).rejects.toThrow('schema_unsupported');
  });
});

describe('Guest PII live deny authority and restore', () => {
  it('exports only closed terminal IDs and atomically restores an exact, monotonic deny marker', async () => {
    const f = await fixture();
    const marker = await f.port.start(f.receipt);
    const terminal = await f.port.complete(
      { ...f.receipt, preparedComplete: true, coreCompleted: true },
      { expectedRevision: marker.revision }
    );
    const authorize = vi.fn(async () => {});
    const page = await listGuestPiiDeletionMarkers(f.adapter, {
      tenantId: f.receipt.tenantId,
      authorize,
    });
    expect(page.markers).toEqual([terminal]);
    expect(authorize).toHaveBeenCalledTimes(2);
    const target = await fixture();
    const statements = prepareRestoredGuestPiiDeletedMarker(terminal, { where: '1=1', params: [] });
    await target.adapter.batch(statements);
    await target.adapter.batch(statements);
    expect(await target.port.get(target.receipt)).toEqual(terminal);
    expect(() => target.insert('users_pii', target.rows.users_pii)).toThrow(
      'guest_pii_erasure_mutation_blocked'
    );
    await expect(
      target.adapter.batch(
        prepareRestoredGuestPiiDeletedMarker(
          { ...terminal, revision: terminal.revision + 1 },
          { where: '1=1', params: [] }
        )
      )
    ).rejects.toThrow();
    await expect(
      target.adapter.batch(
        prepareRestoredGuestPiiDeletedMarker(terminal, { where: '1=0', params: [] })
      )
    ).rejects.toThrow();
    expect(() => normalizeGuestPiiDeletedMarker({ ...terminal, extra: 'secret' })).toThrow(
      'terminal_invalid'
    );
  });
  it('refuses active erasure or an authority epoch change without returning a healthy empty page', async () => {
    const f = await fixture();
    await f.port.start(f.receipt);
    await expect(
      listGuestPiiDeletionMarkers(f.adapter, {
        tenantId: f.receipt.tenantId,
        authorize: async () => {},
      })
    ).rejects.toThrow('authority_held');
    const revision = Number(
      f.db.prepare('SELECT revision FROM guest_pii_mutation_epoch').get()?.revision
    );
    await expect(
      listGuestPiiDeletionMarkers(f.adapter, {
        tenantId: 'foreign',
        expectedEpochRevision: revision - 1,
        authorize: async () => {},
      })
    ).rejects.toThrow('authority_changed');
    const query = f.adapter.query.bind(f.adapter);
    f.adapter.query = async <T>(sql: string, params?: unknown[]) => {
      const rows = await query<T>(sql, params);
      f.db.exec('UPDATE guest_pii_mutation_epoch SET revision=revision+1');
      return rows;
    };
    await expect(
      listGuestPiiDeletionMarkers(f.adapter, { tenantId: 'foreign', authorize: async () => {} })
    ).rejects.toThrow('authority_changed');
  });
});
