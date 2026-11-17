import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withRequestEnvironment } from './inbound-request-environment';
import { renderPortableMigrationSql } from '../../../ar-lib-core/dist/migrations/sql-portability';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import { updateProvider } from '../services/provider-store';
const mocks = vi.hoisted(() => ({ adapter: { queryOne: vi.fn(), execute: vi.fn() } }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  resolveAuthCorePersistenceAdapterFromEnv: async () => mocks.adapter,
}));
let db: SQLiteDatabase | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});
describe('normal provider updates preserve the concurrent incoming binding in SQL', () => {
  it('keeps the current reserved selector when a General save read an older selector', async () => {
    const store = new DatabaseSync(':memory:');
    db = store;
    const migration = new URL(
      '../../../../migrations/core/d1/001_0_5_0_core_baseline.sql',
      import.meta.url
    );
    store.exec(renderPortableMigrationSql(readFileSync(migration, 'utf8'), 'sqlite'));
    const old = { fieldMappingSetId: 'old-set', fieldMappingVersionId: 'old-version' };
    const current = { fieldMappingSetId: 'new-set', fieldMappingVersionId: 'new-version' };
    store
      .prepare(
        `INSERT INTO upstream_providers
      (id, tenant_id, name, provider_type, client_id, client_secret_encrypted, scopes, provider_quirks, created_at, updated_at)
      VALUES ('synthetic-op', 'default', 'Synthetic OP', 'oidc', 'synthetic-client', '', 'openid', ?, 1, 1)`
      )
      .run(JSON.stringify({ responseType: 'code', inboundIdentityMapping: old }));
    mocks.adapter.queryOne.mockImplementation(async (sql: string, params: SQLInputValue[]) =>
      store.prepare(sql).get(...params)
    );
    mocks.adapter.execute.mockImplementation(async (sql: string, params: SQLInputValue[]) => {
      // Another authorized mapping save completes after General's read, before its write.
      store
        .prepare(
          "UPDATE upstream_providers SET provider_quirks = json_set(provider_quirks, '$.inboundIdentityMapping', json(?)) WHERE id='synthetic-op'"
        )
        .run(JSON.stringify(current));
      const result = store.prepare(sql).run(...params);
      return { success: true, rowsAffected: Number(result.changes) };
    });
    await withRequestEnvironment((env) =>
      updateProvider(env, 'default', 'synthetic-op', {
        name: 'Renamed',
        providerQuirks: { responseType: 'code id_token', inboundIdentityMapping: old },
      })
    );
    const rows = store
      .prepare(
        "SELECT name, json_extract(provider_quirks, '$.inboundIdentityMapping.fieldMappingSetId') AS set_id, json_extract(provider_quirks, '$.responseType') AS response_type FROM upstream_providers WHERE id='synthetic-op'"
      )
      .all();
    expect(rows).toEqual([{ name: 'Renamed', set_id: 'new-set', response_type: 'code id_token' }]);
  });
});
