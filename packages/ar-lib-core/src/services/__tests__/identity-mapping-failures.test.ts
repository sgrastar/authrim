import { readRenderedMigrationSql } from '../../../../../test/helpers/migration-source.mjs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import type { Env } from '../../types/env';
import {
  recordIdentityMappingFailure,
  scheduleIdentityMappingFailure,
  type IdentityMappingFailureRow,
  type RecordIdentityMappingFailureInput,
} from '../identity-mapping-failures';
import { DatabaseSync, type SQLInputValue } from './sqlite-history-fixture';

let db: DatabaseSync;
let adapter: Pick<DatabaseAdapter, 'execute'>;
const input = (
  changes: Partial<RecordIdentityMappingFailureInput> = {}
): RecordIdentityMappingFailureInput => ({
  tenantId: 'tenant-a',
  clientId: 'app-1',
  code: 'set_inactive',
  now: 1_800_000_000_000,
  ...changes,
});
const rows = () =>
  db
    .prepare('SELECT * FROM identity_mapping_failures ORDER BY id')
    .all() as IdentityMappingFailureRow[];

/** Exercises scheduling through the real dedicated Admin D1 adapter, over actual SQLite SQL. */
function binding(database: DatabaseSync): D1Database {
  const result = <T>(values: T[], changes = 0): D1Result<T> => ({
    success: true,
    results: values,
    meta: {
      changes,
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
    },
  });
  const prepare = (sql: string): D1PreparedStatement => {
    let params: SQLInputValue[] = [];
    return {
      bind(...values) {
        params = values as SQLInputValue[];
        return this;
      },
      async first<T>(column?: string): Promise<T | null> {
        const row = database.prepare(sql).get(...params) as Record<string, unknown> | undefined;
        return ((column ? row?.[column] : row) as T | undefined) ?? null;
      },
      async run<T>() {
        return result<T>([], Number(database.prepare(sql).run(...params).changes));
      },
      async all<T>() {
        return result(database.prepare(sql).all(...params) as T[]);
      },
      raw() {
        throw new Error('fixture_unused_raw');
      },
    };
  };
  const batch = async <T>(statements: D1PreparedStatement[]) =>
    Promise.all(statements.map((statement) => statement.run<T>()));
  return {
    prepare,
    batch,
    withSession: () => ({ prepare, batch, getBookmark: () => null }),
    async exec(sql) {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    readRenderedMigrationSql(
      new URL('../../../../../migrations/admin/d1/', import.meta.url),
      '001_0_5_0_admin_baseline.sql'
    )
  );
  adapter = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
    })),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe('atomic failure aggregation', () => {
  it('counts parallel nullable-tuple observations in one row with no read/modify/write', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        recordIdentityMappingFailure(adapter, input({ now: 1_800_000_000_000 + index }))
      )
    );
    expect(rows()).toMatchObject([
      {
        tenant_id: 'tenant-a',
        client_id: 'app-1',
        code: 'set_inactive',
        tier: null,
        set_id: null,
        first_at: 1_800_000_000_000,
        last_at: 1_800_000_000_039,
        count: 40,
      },
    ]);
    expect(rows()[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(adapter.execute).toHaveBeenCalledTimes(40);
    expect(
      vi
        .mocked(adapter.execute)
        .mock.calls.every(
          ([sql]) =>
            sql.startsWith('INSERT INTO identity_mapping_failures') &&
            sql.includes('ON CONFLICT(id)')
        )
    ).toBe(true);
  });
  it('keeps first/last at their extrema when the clock rolls back', async () => {
    for (const now of [200, 200, 100, 150, 300])
      await recordIdentityMappingFailure(adapter, input({ now }));
    expect(rows()).toMatchObject([{ first_at: 100, last_at: 300, count: 5 }]);
    const types = db
      .prepare(
        'SELECT typeof(first_at) AS first_type,typeof(last_at) AS last_type,typeof(count) AS count_type FROM identity_mapping_failures'
      )
      .get();
    expect(types).toEqual({ first_type: 'integer', last_type: 'integer', count_type: 'integer' });
  });
  it('partitions the same client by tenant, code, tier and set without tuple delimiter collisions', async () => {
    for (const changes of [
      {},
      { tenantId: 'tenant-b' },
      { clientId: 'app-2' },
      { code: 'set_missing' },
      { tier: 'client' as const },
      { tier: 'tenant_default' as const },
      { tier: 'platform_default' as const },
      { setId: 'set-a' },
      { setId: 'set-b' },
      { tenantId: 'a:b', clientId: 'c' },
      { tenantId: 'a', clientId: 'b:c' },
    ])
      await recordIdentityMappingFailure(adapter, input(changes));
    expect(rows()).toHaveLength(11);
    expect(new Set(rows().map((row) => row.id)).size).toBe(11);
    expect(rows().every((row) => row.count === 1)).toBe(true);
  });
  it.each([
    'default_setting_invalid',
    'client_selector_invalid',
    'settings_unreadable',
    'set_missing',
    'set_inactive',
    'destination_profile_invalid',
    'admin_database_unavailable',
    'policy.invalid_destination_profile_binding',
    'policy.identity_mapping_failed',
    'policy.missing_destination_subject',
    'policy.persistent_identifier_profile_not_found',
    'policy.persistent_identifier_profile_unsupported_mode',
    'policy.persistent_identifier_secret_missing',
    'policy.identity_mapping_reserved_subject',
    'policy.missing_identity_mapping_binding',
    'policy.invalid_default_identity_mapping',
    'policy.invalid_client_identity_mapping',
  ])('stores only the explicitly supported code %s', async (code) => {
    await recordIdentityMappingFailure(adapter, input({ code }));
    expect(rows()[0].code).toBe(code);
  });
  it('normalizes unknown codes and malformed optional context without storing their content', async () => {
    const malformed = Object.assign(
      input({ code: 'private-claim-value', setId: 'secret@example.test' }),
      {
        tier: 'private-user-id',
        userId: 'private-user-id',
        claims: { email: 'secret@example.test' },
        message: 'private-message',
        stack: 'private-stack',
        cause: 'private-cause',
      }
    );
    await recordIdentityMappingFailure(adapter, malformed);
    await recordIdentityMappingFailure(
      adapter,
      input({ code: 'another-private-message', setId: 'none' })
    );
    expect(rows()).toMatchObject([{ code: 'mapping_failed', tier: null, set_id: null, count: 2 }]);
    const stored = JSON.stringify(rows());
    for (const value of ['private', 'secret@example.test', 'email', 'claims', 'cause', 'stack'])
      expect(stored).not.toContain(value);
    expect(Object.keys(rows()[0]).sort()).toEqual([
      'client_id',
      'code',
      'count',
      'first_at',
      'id',
      'last_at',
      'set_id',
      'tenant_id',
      'tier',
    ]);
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid millisecond timestamp %s before SQL',
    async (now) => {
      await expect(recordIdentityMappingFailure(adapter, input({ now }))).rejects.toThrow(
        'identity_mapping_failure_invalid'
      );
      expect(adapter.execute).not.toHaveBeenCalled();
    }
  );
  it.each([{ tenantId: '' }, { clientId: 'app\nvalue' }, { clientId: 'x'.repeat(257) }])(
    'rejects malformed required identifiers %j before SQL',
    async (changes) => {
      await expect(recordIdentityMappingFailure(adapter, input(changes))).rejects.toThrow(
        'identity_mapping_failure_invalid'
      );
      expect(adapter.execute).not.toHaveBeenCalled();
    }
  );
  it('keeps integer zero and safe-maximum timestamps, and fails rather than overflowing count', async () => {
    await recordIdentityMappingFailure(adapter, input({ now: 0 }));
    await recordIdentityMappingFailure(adapter, input({ now: Number.MAX_SAFE_INTEGER }));
    expect(rows()).toMatchObject([{ first_at: 0, last_at: Number.MAX_SAFE_INTEGER, count: 2 }]);
    db.prepare('UPDATE identity_mapping_failures SET count=?').run(Number.MAX_SAFE_INTEGER);
    await expect(recordIdentityMappingFailure(adapter, input())).rejects.toThrow();
    expect(rows()[0].count).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('does not increment a row whose stored identity does not match its tuple hash', async () => {
    await recordIdentityMappingFailure(adapter, input());
    db.prepare('UPDATE identity_mapping_failures SET tenant_id=?').run('tenant-other');
    await expect(recordIdentityMappingFailure(adapter, input())).rejects.toThrow(
      'identity_mapping_failure_unavailable'
    );
    expect(rows()).toMatchObject([{ tenant_id: 'tenant-other', count: 1 }]);
  });
  it('rejects unsuccessful adapter results', async () => {
    await expect(
      recordIdentityMappingFailure(
        {
          execute: async () => ({ success: false, rowsAffected: 0 }),
        },
        input()
      )
    ).rejects.toThrow('identity_mapping_failure_unavailable');
    expect(rows()).toEqual([]);
  });
});

describe('best-effort scheduling', () => {
  it('schedules a caught promise using dedicated Admin SQL and snapshots only permitted scalars', async () => {
    const pending: Promise<unknown>[] = [];
    const failure = {
      code: 'set_inactive',
      tier: 'platform_default' as const,
      setId: 'set-platform',
    };
    const source = binding(db);
    const prepare = vi.spyOn(source, 'prepare');
    vi.spyOn(Date, 'now').mockReturnValue(123);
    scheduleIdentityMappingFailure({
      env: { DB_ADMIN: source },
      tenantId: 'tenant-a',
      clientId: 'app-1',
      failure,
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    failure.code = 'set_missing';
    failure.setId = 'changed-after-scheduling';
    expect(prepare).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(rows()).toMatchObject([
      {
        code: 'set_inactive',
        tier: 'platform_default',
        set_id: 'set-platform',
        first_at: 123,
        last_at: 123,
        count: 1,
      },
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it.each(['absent', 'throws'] as const)('does no IO when waitUntil %s', async (mode) => {
    const access = vi.fn(() => binding(db));
    const env = {
      get DB_ADMIN() {
        return access();
      },
    };
    const pending: Promise<unknown>[] = [];
    expect(() =>
      scheduleIdentityMappingFailure({
        env,
        tenantId: 'tenant-a',
        clientId: 'app-1',
        failure: { code: 'set_inactive' },
        ...(mode === 'throws'
          ? {
              waitUntil: (promise: Promise<unknown>) => {
                pending.push(promise);
                throw new Error('scheduler_unavailable');
              },
            }
          : {}),
      })
    ).not.toThrow();
    await expect(Promise.all(pending)).resolves.toEqual(mode === 'throws' ? [undefined] : []);
    expect(access).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
  it('never falls back to a Core database when Admin is missing', async () => {
    const core = binding(db);
    const corePrepare = vi.spyOn(core, 'prepare');
    const env = { DB_ADMIN: undefined, DB: core };
    const pending: Promise<unknown>[] = [];
    scheduleIdentityMappingFailure({
      env,
      tenantId: 'tenant-a',
      clientId: 'app-1',
      failure: {},
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(corePrepare).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });
  it('absorbs an Admin binding getter failure after successful scheduling', async () => {
    const env: Partial<Pick<Env, 'DB_ADMIN'>> = {
      get DB_ADMIN() {
        throw new Error('private-binding-detail');
      },
    };
    const pending: Promise<unknown>[] = [];
    scheduleIdentityMappingFailure({
      env,
      tenantId: 'tenant-a',
      clientId: 'app-1',
      failure: {},
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(rows()).toEqual([]);
  });
  it('absorbs a real SQL failure, leaving a fulfilled scheduled promise and no row', async () => {
    db.exec(
      "CREATE TRIGGER refuse_failure BEFORE INSERT ON identity_mapping_failures BEGIN SELECT RAISE(ABORT,'fixture_write_refused'); END"
    );
    const pending: Promise<unknown>[] = [];
    scheduleIdentityMappingFailure({
      env: { DB_ADMIN: binding(db) },
      tenantId: 'tenant-a',
      clientId: 'app-1',
      failure: {},
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(rows()).toEqual([]);
  });
});
