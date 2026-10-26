// @ts-expect-error node:sqlite is available in the required runtime but this package omits Node types.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import {
  SQLITE_SNAPSHOT_SCHEMA,
  type CaptureSchema,
} from '@authrim/ar-lib-core/services/tenant-portability/sqlite-snapshot';
import { sqliteCapturePlan } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-capture-plan';
import { PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-modules';
import type { PlannedInstalledSqliteDataset } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { AdapterContext } from '../tenant-backup-export-dispatcher';
import {
  assertSamlDrSqlInventoryFrozen,
  readBoundedSamlDrSqlRows,
  readFrozenSamlDrSqlRows,
  readLiveSamlDrSqlInventory,
  samlDrAccountInventory,
  SAML_DR_INVENTORY_COLUMNS,
} from '../tenant-backup-saml-dr-sql-source';

interface LocalSqlite {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}
const Sqlite = DatabaseSync as unknown as new (path: string) => LocalSqlite;
const databases: LocalSqlite[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
function fixture() {
  const database = new Sqlite(':memory:');
  databases.push(database);
  database.exec(`
    CREATE TABLE users_core(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL);
    CREATE TABLE identity_accounts(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, account_type TEXT,
      legacy_user_id TEXT,lifecycle_state TEXT,directory_publication_state TEXT,account_route_generation INTEGER);
    CREATE TABLE passkeys(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT,credential_id TEXT,counter INTEGER,created_at INTEGER);
    CREATE TABLE oauth_clients(client_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,description TEXT);
    CREATE TABLE web_origin_registry(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,client_id TEXT,origin TEXT);
    INSERT INTO users_core VALUES ('user-a','tenant-a');
    INSERT INTO identity_accounts VALUES ('account:user-a','tenant-a','user','user-a','active','active',3);
    INSERT INTO passkeys VALUES ('passkey-a','tenant-a','user-a','credential-a',7,1);
    INSERT INTO oauth_clients VALUES ('login-ui','tenant-a','System-managed public OAuth client used by the built-in Authrim Login UI.');
    INSERT INTO web_origin_registry VALUES ('origin-a','tenant-a','login-ui','https://idp.example.test');
  `);
  database.exec(SQLITE_SNAPSHOT_SCHEMA);
  const schemas: CaptureSchema[] = [
    ...Object.entries(SAML_DR_INVENTORY_COLUMNS).map(([id, columns]) => ({
      table: id.slice(5),
      columns,
      primaryKey: ['id'],
      tenantColumn: 'tenant_id',
      uniqueKeys: [],
    })),
    {
      table: 'oauth_clients',
      columns: ['client_id', 'tenant_id', 'description'],
      primaryKey: ['client_id'],
      tenantColumn: 'tenant_id',
      uniqueKeys: [],
    },
    {
      table: 'web_origin_registry',
      columns: ['id', 'tenant_id', 'client_id', 'origin'],
      primaryKey: ['id'],
      tenantColumn: 'tenant_id',
      uniqueKeys: [],
    },
  ];
  for (const trigger of sqliteCapturePlan(schemas).triggers) database.exec(trigger.sql);
  const adapter = {
    query: async (sql: string, params: unknown[] = []) => database.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) =>
      database.prepare(sql).get(...params) ?? null,
  } as unknown as DatabaseAdapter;
  const plan = schemas.map((capture, ordinal) => ({
    ...PHASE8_CUMULATIVE_SQLITE_DATASET_REGISTRATIONS.find(
      (entry) => entry.dataset.id === `core.${capture.table}`
    ),
    capture,
    ordinal,
    firstOrdinal: 0,
    resourceId: 'core-a',
  })) as PlannedInstalledSqliteDataset[];
  const context = {
    context: {
      operation: { kind: 'export', state: 'running', id: 'operation-a', tenant_id: 'tenant-a' },
      lease: { operationId: 'operation-a', tenantId: 'tenant-a' },
      signal: new AbortController().signal,
    },
    inventory: { headForLease: async () => ({ state: 'sealed', chain_digest: 'a'.repeat(64) }) },
    snapshotResources: {
      loadCapture: async () => ({ snapshotId: 'snapshot-a' }),
      assertCaptureOwner: async () => {},
    },
    databases: {
      fixed: [],
      tenant: [
        {
          databaseId: 'core-a',
          assignments: [{ dataRole: 'tenant_core/default' }, { dataRole: 'tenant_core/users' }],
        },
      ],
    },
    selection: { settings: true, users: true },
    resolveSource: async () => adapter,
  } as unknown as AdapterContext;
  return {
    database,
    adapter,
    plan,
    context,
    start: () =>
      database.exec(
        "INSERT INTO tenant_backup_snapshots VALUES ('snapshot-a','tenant-a','capturing',NULL)"
      ),
  };
}

describe('SAML DR existing SQL snapshot source', () => {
  it('reads setup Login UI from COW and reconciles Core after current source changed', async () => {
    const f = fixture();
    const captured = await readLiveSamlDrSqlInventory(f.context, f.plan, async () => {});
    expect(samlDrAccountInventory('tenant-a', captured)[0].passkeys[0]).toMatchObject({
      counter: '7',
      updatedAtMs: 1,
    });
    f.start();
    f.database.exec(
      "UPDATE passkeys SET counter=9; UPDATE oauth_clients SET description='current'; INSERT INTO users_core VALUES ('later','tenant-a');"
    );
    await expect(
      assertSamlDrSqlInventoryFrozen(f.context, f.plan, captured)
    ).resolves.toBeUndefined();
    const clients = await readFrozenSamlDrSqlRows(f.context, f.plan, 'core.oauth_clients');
    expect(clients[0].description).toEqual([
      'text',
      'System-managed public OAuth client used by the built-in Authrim Login UI.',
    ]);
    captured['core.passkeys'][0] = { ...captured['core.passkeys'][0], counter: ['integer', '6'] };
    await expect(assertSamlDrSqlInventoryFrozen(f.context, f.plan, captured)).rejects.toThrow(
      'saml_dr_sql_source_invalid'
    );
  });
  it('preserves integer precision and rejects row count overflow', async () => {
    const f = fixture();
    f.database.exec('UPDATE passkeys SET counter=9007199254740993');
    expect(
      (
        await readBoundedSamlDrSqlRows(f.adapter, 'passkeys', ['counter'], 'tenant_id=?', [
          'tenant-a',
        ])
      )[0].counter
    ).toEqual(['integer', '9007199254740993']);
    await expect(
      readBoundedSamlDrSqlRows(f.adapter, 'passkeys', ['id'], 'tenant_id=?', ['tenant-a'], 0)
    ).rejects.toThrow('saml_dr_sql_source_invalid');
  });
  it.each(['missing_account', 'foreign_tenant', 'unpublished', 'missing_user', 'duplicate_user'])(
    'rejects incomplete Core inventory: %s',
    async (kind) => {
      const f = fixture();
      const captured = await readLiveSamlDrSqlInventory(f.context, f.plan, async () => {});
      if (kind === 'missing_account') captured['core.identity_accounts'] = [];
      if (kind === 'foreign_tenant')
        captured['core.passkeys'][0] = {
          ...captured['core.passkeys'][0],
          tenant_id: ['text', 'other'],
        };
      if (kind === 'unpublished')
        captured['core.identity_accounts'][0] = {
          ...captured['core.identity_accounts'][0],
          directory_publication_state: ['text', 'pending'],
        };
      if (kind === 'missing_user')
        captured['core.passkeys'][0] = {
          ...captured['core.passkeys'][0],
          user_id: ['text', 'other'],
        };
      if (kind === 'duplicate_user')
        captured['core.users_core'].push(captured['core.users_core'][0]);
      expect(() => samlDrAccountInventory('tenant-a', captured)).toThrow(
        'saml_dr_sql_source_invalid'
      );
    }
  );
  it('does not silently read an unowned Core physical source', async () => {
    const f = fixture();
    f.context.databases.tenant[0].assignments = [];
    await expect(readLiveSamlDrSqlInventory(f.context, f.plan, async () => {})).rejects.toThrow(
      'saml_dr_sql_source_invalid'
    );
  });
});
