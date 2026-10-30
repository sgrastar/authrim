import { readMigrationSource } from '../../../../../test/helpers/migration-source.mjs';
import { createRequire } from 'node:module';
type SQLInputValue = string | number | null;
interface TestSqlite {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    all(...params: SQLInputValue[]): Record<string, unknown>[];
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint };
  };
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TestSqlite;
};

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../adapter';
import {
  recordCanonicalLastLogin,
  recordLastLoginStatement,
} from '../protected-identity-mutations';
import { CanonicalRuntimeUserStore } from '../../repositories/identity/canonical-runtime-user-store';
import { withGroupInputWrite } from '../../services/dynamic-groups/write-boundary';

describe('shared protected last-login operation with native D1 effects', () => {
  let sqlite: TestSqlite;
  let adapter: DatabaseAdapter;
  let store: CanonicalRuntimeUserStore;
  const input = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    accountId: 'account-a',
    operationId: 'login-a',
    observedAtMs: 2000,
  };
  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE identity_accounts (
      id TEXT PRIMARY KEY, tenant_id TEXT, legacy_user_id TEXT, account_type TEXT,
      lifecycle_state TEXT, directory_publication_state TEXT, registration_state TEXT,
      display_label TEXT, metadata_json TEXT, updated_at INTEGER, deleted_at INTEGER);
      INSERT INTO identity_accounts VALUES ('account-a','tenant-a','user-a','user','active',
      'active','registered','original','{"precise":9007199254740993,"other":"keep"}',1000,NULL);
      CREATE TABLE service_group_inputs (tenant_id TEXT,user_id TEXT,revision INTEGER,
      PRIMARY KEY(tenant_id,user_id));`);
    const migration = (name: string) =>
      readMigrationSource(
        new URL(`../../../../../migrations/core/d1/`, import.meta.url),
        `${name}.sql`
      );
    const webhook = migration('005_account_webhook_outbox');
    sqlite.exec(webhook.match(/CREATE TABLE account_webhook_outbox \([\s\S]*?\n\);/u)?.[0] ?? '');
    sqlite.exec(
      (
        webhook.match(/CREATE TRIGGER account_webhook_updated [\s\S]*?\nEND;/u)?.[0] ?? ''
      ).replaceAll('__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__', '2000')
    );
    sqlite.exec(
      migration('007_service_dynamic_groups').match(
        /CREATE TRIGGER sg_identity_accounts_update [\s\S]*?\nEND;/u
      )?.[0] ?? ''
    );
    const params = (values: unknown[] = []) => values as SQLInputValue[];
    adapter = {
      async query<T>(sql: string, values?: unknown[]) {
        return sqlite.prepare(sql).all(...params(values)) as T[];
      },
      async queryOne<T>(sql: string, values?: unknown[]) {
        return (sqlite.prepare(sql).get(...params(values)) ?? null) as T | null;
      },
      async execute(sql, values) {
        const before = Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n);
        sqlite.prepare(sql).run(...params(values));
        return {
          success: true,
          rowsAffected: Number(sqlite.prepare('SELECT total_changes() AS n').get()?.n) - before,
        };
      },
      async close() {},
      async transaction() {
        throw new Error('unused');
      },
      async batch() {
        throw new Error('unused');
      },
      async isHealthy() {
        return { healthy: true, latencyMs: 0, type: 'd1' };
      },
      getType() {
        return 'd1';
      },
    };
    store = new CanonicalRuntimeUserStore({
      coreAdapter: adapter,
      piiAdapter: adapter,
      tenantId: 'tenant-a',
    });
  });
  afterEach(() => sqlite.close());
  const row = () => sqlite.prepare('SELECT * FROM identity_accounts').get();
  const effects = () => ({
    outbox: sqlite.prepare('SELECT event_type,changed_field FROM account_webhook_outbox').all(),
    revisions: sqlite.prepare('SELECT revision FROM service_group_inputs').all(),
  });

  it('uses the real repository path, preserves unrelated precise JSON and emits native effects once', async () => {
    expect(await store.touchLastLogin('user-a', 2000)).toBe(true);
    expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
    expect(await store.touchLastLogin('user-a', 1999)).toBe(false);
    expect(row()).toMatchObject({
      metadata_json: '{"precise":9007199254740993,"other":"keep","last_login_at":2000}',
      lifecycle_state: 'active',
      display_label: 'original',
      updated_at: 2000,
      deleted_at: null,
    });
    expect(effects()).toEqual({
      outbox: [{ event_type: 'account.updated', changed_field: 'account' }],
      revisions: [{ revision: 1 }],
    });
  });

  it('accepts D1 trigger-inclusive changes for a real group boundary and removes it on completion', async () => {
    const sql = readMigrationSource(
      new URL('../../../../../migrations/core/d1/', import.meta.url),
      '007_service_dynamic_groups.sql'
    );
    const definition = sql.match(
      /CREATE TABLE service_group_write_boundaries \([\s\S]*?\n\);/u
    )?.[0];
    const insert = sql.match(/CREATE TRIGGER sg_write_boundary_insert [\s\S]*?\nEND;/u)?.[0];
    const remove = sql.match(/CREATE TRIGGER sg_write_boundary_delete [\s\S]*?\nEND;/u)?.[0];
    if (!definition || !insert || !remove) throw new Error('test_boundary_contract_missing');
    sqlite.exec(definition + insert + remove);
    const execute = vi.spyOn(adapter, 'execute');
    expect(
      await withGroupInputWrite(adapter, 'tenant-a', 'user-a', 'profile', async () => {
        expect(
          sqlite.prepare('SELECT COUNT(*) AS n FROM service_group_write_boundaries').get()?.n
        ).toBe(1);
        return 'saved';
      })
    ).toBe('saved');
    expect(await execute.mock.results[0].value).toMatchObject({ success: true, rowsAffected: 2 });
    expect(
      sqlite.prepare('SELECT COUNT(*) AS n FROM service_group_write_boundaries').get()?.n
    ).toBe(0);
    expect(sqlite.prepare('SELECT revision FROM service_group_inputs').get()?.revision).toBe(2);
  });

  it('does not call the writer when D1 reports zero boundary changes', async () => {
    vi.spyOn(adapter, 'execute').mockResolvedValueOnce({ success: true, rowsAffected: 0 });
    const write = vi.fn(async () => 'must-not-run');
    await expect(
      withGroupInputWrite(adapter, 'tenant-a', 'user-a', 'profile', write)
    ).rejects.toThrow('group_boundary_write_failed');
    expect(write).not.toHaveBeenCalled();
  });

  it('does not restore lifecycle/display metadata from the account read before an intervening suspension', async () => {
    const read = adapter.queryOne.bind(adapter);
    vi.spyOn(adapter, 'queryOne').mockImplementationOnce(async (sql, params) => {
      const snapshot = await read(sql, params);
      sqlite.exec(
        "UPDATE identity_accounts SET lifecycle_state='suspended',display_label='new',updated_at=3000"
      );
      return snapshot;
    });
    expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
    expect(row()).toMatchObject({
      lifecycle_state: 'suspended',
      display_label: 'new',
      updated_at: 3000,
    });
    expect(effects().outbox).toHaveLength(1); // suspension itself, no login side effect
    expect(row()?.metadata_json).not.toContain('last_login_at');
  });

  it('rolls back the account and group revision when the native outbox cannot be written', async () => {
    sqlite.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON account_webhook_outbox BEGIN SELECT RAISE(ABORT,'synthetic'); END;"
    );
    await expect(store.touchLastLogin('user-a', 2000)).rejects.toThrow('synthetic');
    expect(row()?.metadata_json).not.toContain('last_login_at');
    expect(effects()).toEqual({ outbox: [], revisions: [] });
  });

  it.each(['suspended', 'deleting', 'deleted'])('does not write a %s account', async (state) => {
    sqlite.prepare('UPDATE identity_accounts SET lifecycle_state=?').run(state);
    expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
    expect(row()?.metadata_json).not.toContain('last_login_at');
  });

  it.each([{ tenantId: 'tenant-b' }, { accountId: 'account-b' }, { userId: 'user-b' }])(
    'rejects a wrong identity scope %j',
    async (patch) => {
      expect(await recordCanonicalLastLogin(adapter, { ...input, ...patch })).toBe(false);
      expect(effects()).toEqual({ outbox: [], revisions: [] });
    }
  );

  it.each([null, 'wrong', -1, 1.5])(
    'does not repair an invalid prior last-login value %j silently',
    async (prior) => {
      sqlite
        .prepare('UPDATE identity_accounts SET metadata_json=?')
        .run(JSON.stringify({ last_login_at: prior }));
      expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
    }
  );

  it('dispatches an explicit adapter capability through the same repository entry point', async () => {
    const recordLastLogin = vi.fn(async () => true);
    const protectedAdapter = {
      ...adapter,
      getType: () => 'aurora-dsql',
      protectedIdentityMutations: { version: 'protected-identity-v1' as const, recordLastLogin },
    };
    const protectedStore = new CanonicalRuntimeUserStore({
      coreAdapter: protectedAdapter,
      piiAdapter: adapter,
      tenantId: 'tenant-a',
    });
    expect(await protectedStore.touchLastLogin('user-a', 2000)).toBe(true);
    expect(recordLastLogin).toHaveBeenCalledWith({
      ...input,
      operationId: 'last-login:user-a:2000',
    });
    expect(effects()).toEqual({ outbox: [], revisions: [] });
  });

  it('rejects an adapter without native effects or an explicit capability', async () => {
    await expect(
      recordCanonicalLastLogin({ ...adapter, getType: () => 'aurora-dsql' }, input)
    ).rejects.toThrow('protected_identity_mutation_backend_unsupported');
    expect(effects()).toEqual({ outbox: [], revisions: [] });
  });

  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid timestamp %s before SQL',
    async (time) => {
      await expect(
        recordCanonicalLastLogin(adapter, { ...input, observedAtMs: time })
      ).rejects.toThrow('protected_identity_mutation_input_invalid');
    }
  );

  it('does not admit SQL identifiers or control characters from request input', () => {
    expect(() =>
      recordLastLoginStatement('postgres', input, 'identity_accounts; DROP TABLE identity_accounts')
    ).toThrow('protected_identity_table_invalid');
    expect(() =>
      recordLastLoginStatement('postgres', { ...input, tenantId: 'secret\nvalue' })
    ).toThrow('protected_identity_mutation_input_invalid');
  });
});
