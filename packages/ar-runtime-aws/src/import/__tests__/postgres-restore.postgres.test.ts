import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client, Pool } from 'pg';
import { freshInstallMigrationFiles } from '../../migrations/fresh-install-files';
import { verifyActivatedDatabaseRows } from '../../startup/live-database-verification';
import { verifyActivatedLoginProjections } from '../../startup/live-login-projections';
import { expect, it, vi } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/src/migrations/sql-portability';
import type { VerifiedTenantBackupV2 } from '../backup-reader';
import {
  assertPostgresBackupProjectionSupported,
  UnsupportedPostgresBackupProjectionError,
  readPostgresFamilyStagingReceipt,
  restoreVerifiedPostgresFamily,
  type PostgresFamilyStagingReceiptRow,
  validatePostgresFamilyStagingReceiptRow,
  verifyPostgresFamilyStagingRows,
} from '../postgres-restore';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../postgres-restore-table-contract';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../postgres-restore-extension-contract';
import { expectPostgresRestoreReceiptTables } from './postgres-restore-receipt-expectations';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
const run = databaseUrl ? it : it.skip;
const now = 1_780_000_000_000;

function urlFor(name: string): string {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function withFamilyDatabase<T>(
  family: 'core' | 'pii',
  runTest: (connectionString: string, client: Client) => Promise<T>
): Promise<T> {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
  const name = `aws_restore_${family}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString: databaseUrl });
  const client = new Client({ connectionString: urlFor(name) });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    try {
      await client.connect();
      const migrations = new URL(
        `../../../../../migrations/${family}/postgresql/`,
        import.meta.url
      );
      for (const file of freshInstallMigrationFiles(await readdir(migrations))) {
        await client.query<Record<string, unknown>>('SET search_path TO public');
        await client.query<Record<string, unknown>>(
          renderPortableMigrationSql(await readFile(new URL(file, migrations), 'utf8'), 'postgres')
        );
      }
      await client.query<Record<string, unknown>>('SET search_path TO public');
      return await runTest(urlFor(name), client);
    } finally {
      await client.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    }
  } finally {
    await admin.end();
  }
}

type Tagged = readonly ['text' | 'integer' | 'null', string | null];
function row(datasetId: string, values: Record<string, Tagged>): PortableSqliteRow {
  const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((entry) => entry.datasetId === datasetId);
  if (!spec) throw new Error(`unknown test table ${datasetId}`);
  return Object.fromEntries(
    spec.columns.map((column) => [column, values[column] ?? ['null', null]])
  );
}

const t = (value: string): Tagged => ['text', value];
const i = (value: number | string): Tagged => ['integer', String(value)];

function backup(
  family: 'core' | 'pii',
  rows: Readonly<Record<string, readonly PortableSqliteRow[]>>,
  extra?: Readonly<Record<string, readonly PortableSqliteRow[]>>
): VerifiedTenantBackupV2 {
  const all = { ...rows, ...extra };
  const descriptors = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === family).map(
    (spec) => ({
      id: spec.datasetId,
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    })
  );
  for (const id of Object.keys(extra ?? {})) {
    descriptors.push({
      id,
      module: 'users',
      kind: 'users',
      store: 'database',
      schemaVersion: 1,
      disposition: 'include',
    });
  }
  return {
    manifest: {
      formatVersion: 1,
      bundleId: 'a'.repeat(32),
      snapshotId: 'snapshot-a',
      inventoryDigestSha256: 'b'.repeat(64),
      source: { tenantId: 'tenant-a', issuer: 'https://idp.example.test', productVersion: '0.4.2' },
      boundaryUnixMs: now,
      selection: {} as never,
      datasets: descriptors as never,
    },
    dataset(id) {
      const entries = all[id] ?? [];
      const encoded = entries.map((entry) => JSON.stringify(entry));
      return {
        id,
        rows: encoded.length,
        bytes: encoded.reduce(
          (total, item) => total + new TextEncoder().encode(item).byteLength + 1,
          0
        ),
        async readNextRow(cursor) {
          const index = cursor === null ? 0 : Number(cursor);
          const rowJson = encoded[index];
          return rowJson === undefined ? null : { rowJson, nextCursor: String(index + 1) };
        },
      };
    },
    async close() {},
  };
}

function tenantRow(): PortableSqliteRow {
  return row('core.tenants', {
    id: t('tenant-a'),
    tenant_code: t('tenant-a'),
    tenant_key: t('tenant-a'),
    name: t('Tenant A'),
    is_default: i(0),
    created_at: i(now),
    updated_at: i(now),
    lifecycle_state: t('active'),
    isolation_policy: t('tenant_exclusive'),
  });
}

function providerRow(tenantId = 'tenant-a'): PortableSqliteRow {
  return row('core.identity_providers', {
    id: t('provider-a'),
    tenant_id: t(tenantId),
    name: t('SP'),
    provider_type: t('saml_sp'),
    config_json: t('{"entityId":"https://sp.example.test/metadata"}'),
    enabled: i(1),
    created_at: i(now),
    updated_at: i(now),
  });
}

function personRows(): Record<string, readonly PortableSqliteRow[]> {
  return {
    'core.identity_subjects': [
      row('core.identity_subjects', {
        id: t('subject-a'),
        tenant_id: t('tenant-a'),
        subject_type: t('person'),
        lifecycle_state: t('active'),
        primary_account_id: t('account:alice'),
        created_at: i(now),
        updated_at: i(now),
      }),
    ],
    'core.identity_accounts': [
      row('core.identity_accounts', {
        id: t('account:alice'),
        tenant_id: t('tenant-a'),
        account_type: t('user'),
        lifecycle_state: t('active'),
        legacy_user_id: t('alice'),
        primary_subject_id: t('subject-a'),
        directory_publication_state: t('active'),
        account_route_generation: i(7),
        registration_state: t('registered'),
        created_at: i(now),
        updated_at: i(now),
      }),
    ],
    'core.users_core': [
      row('core.users_core', {
        id: t('alice'),
        tenant_id: t('tenant-a'),
        email_verified: i(1),
        phone_number_verified: i(0),
        is_active: i(1),
        user_type: t('end_user'),
        pii_partition: t('default'),
        pii_status: t('pending'),
        email_domain_hash_version: i(1),
        status: t('active'),
        lifecycle_state: t('active'),
        created_at: i(now),
        updated_at: i(now),
      }),
    ],
    'core.passkeys': [
      row('core.passkeys', {
        id: t('passkey-a'),
        tenant_id: t('tenant-a'),
        user_id: t('alice'),
        credential_id: t('credential-a'),
        public_key: t('public-key-a'),
        counter: i(5),
        created_at: i(now),
        rp_id: t('idp.example.test'),
      }),
    ],
    'core.profiles': [
      row('core.profiles', {
        id: t('profile-a'),
        tenant_id: t('tenant-a'),
        subject_id: t('subject-a'),
        profile_type: t('person'),
        lifecycle_state: t('active'),
        created_at: i(now),
        updated_at: i(now),
      }),
    ],
    'core.contact_points': [
      row('core.contact_points', {
        id: t('contact-a'),
        tenant_id: t('tenant-a'),
        subject_id: t('subject-a'),
        account_id: t('account:alice'),
        contact_type: t('email'),
        purpose: t('primary'),
        value_storage_ref: t('users_pii:alice:email'),
        is_primary: i(1),
        verification_state: t('verified'),
        lifecycle_state: t('active'),
        created_at: i(now),
        updated_at: i(now),
      }),
    ],
  };
}

function loginUiRow(): PortableSqliteRow {
  return row('core.oauth_clients', {
    tenant_id: t('tenant-a'),
    client_id: t('login-ui'),
    client_name: t('Login UI'),
    redirect_uris: t('[]'),
    grant_types: t('["authorization_code"]'),
    response_types: t('["code"]'),
    browser_refresh_token_policy: t('disabled'),
    tls_client_certificate_bound_access_tokens: i(0),
    created_at: i(now),
    updated_at: i(now),
  });
}

function originRow(): PortableSqliteRow {
  return row('core.web_origin_registry', {
    id: t('origin-a'),
    tenant_id: t('tenant-a'),
    client_id: t('login-ui'),
    origin: t('https://idp.example.test'),
    cors_allowed: i(1),
    handoff_allowed: i(1),
    iframe_allowed: i(0),
    is_active: i(1),
    created_at: i(now),
    updated_at: i(now),
  });
}

run(
  'commits Core rows and source Login UI supplement under one rereadable staging receipt',
  async () => {
    await withFamilyDatabase('core', async (connectionString, client) => {
      const source = backup('core', {
        'core.tenants': [tenantRow()],
        'core.identity_providers': [providerRow()],
        ...personRows(),
      });
      const targetId = randomUUID();
      const receipt = await restoreVerifiedPostgresFamily({
        backup: source,
        family: 'core',
        tenantId: 'tenant-a',
        targetId,
        connectionString,
        supplementalRows: {
          'core.oauth_clients': [loginUiRow()],
          'core.web_origin_registry': [originRow()],
        },
      });
      expect(receipt.status).toBe('committed_staging');
      expect(
        receipt.tables.find((entry) => entry.datasetId === 'core.oauth_clients')?.rowCount
      ).toBe(1);
      expect(
        receipt.tables.find((entry) => entry.datasetId === 'core.identity_accounts')?.rowCount
      ).toBe(1);
      expect(
        (
          await client.query<{ account_route_generation: string }>(
            "SELECT account_route_generation FROM identity_accounts WHERE id='account:alice'"
          )
        ).rows[0].account_route_generation
      ).toBe('7');
      expect(await readPostgresFamilyStagingReceipt({ connectionString, targetId })).toEqual(
        receipt
      );
      const journalRow = (
        await client.query<PostgresFamilyStagingReceiptRow>(
          'SELECT target_id,tenant_id,family,receipt_json FROM authrim_aws_import_staging WHERE target_id=$1',
          [targetId]
        )
      ).rows[0];
      expect(validatePostgresFamilyStagingReceiptRow(journalRow, targetId)).toEqual(receipt);
      expect(() =>
        validatePostgresFamilyStagingReceiptRow({ ...journalRow, tenant_id: 'tenant-b' }, targetId)
      ).toThrow('aws_postgres_restore_invalid');
      expect(await verifyPostgresFamilyStagingRows({ connectionString, targetId })).toEqual(
        receipt
      );
      await client.query<Record<string, unknown>>(
        "UPDATE identity_accounts SET updated_at=updated_at+1 WHERE id='account:alice'"
      );
      await client.query<Record<string, unknown>>(
        "UPDATE passkeys SET counter=counter+1 WHERE user_id='alice'"
      );
      await expect(verifyPostgresFamilyStagingRows({ connectionString, targetId })).rejects.toThrow(
        'aws_postgres_restore_invalid'
      );
      expect(
        await verifyPostgresFamilyStagingRows({
          connectionString,
          targetId,
          skipDatasetIds: ['core.identity_accounts', 'core.passkeys'],
        })
      ).toEqual(receipt);
      await expect(
        verifyPostgresFamilyStagingRows({
          connectionString,
          targetId,
          skipDatasetIds: ['core.passkeys', 'core.passkeys'],
        })
      ).rejects.toThrow('aws_postgres_restore_invalid');
      await client.query<Record<string, unknown>>(
        `INSERT INTO tenants
           (id, tenant_code, tenant_key, name, is_default, created_at, updated_at,
            lifecycle_state, isolation_policy)
         VALUES ('tenant-b', 'tenant-b', 'tenant-b', 'Tenant B', false, 1, 1,
                 'active', 'tenant_exclusive')`
      );
      await expect(
        verifyPostgresFamilyStagingRows({
          connectionString,
          targetId,
          skipDatasetIds: ['core.identity_accounts', 'core.passkeys'],
        })
      ).rejects.toThrow('aws_postgres_restore_invalid');
      await client.query<Record<string, unknown>>("DELETE FROM tenants WHERE id='tenant-b'");
      expect(
        (
          await client.query<Record<string, unknown>>(
            'SELECT tenant_id, client_id FROM web_origin_registry'
          )
        ).rows
      ).toEqual([expect.objectContaining({ tenant_id: 'tenant-a', client_id: 'login-ui' })]);
      await expect(
        restoreVerifiedPostgresFamily({
          backup: source,
          family: 'core',
          tenantId: 'tenant-a',
          targetId: randomUUID(),
          connectionString,
        })
      ).rejects.toThrow('aws_postgres_restore_invalid');
      expect(await readPostgresFamilyStagingReceipt({ connectionString, targetId })).toEqual(
        receipt
      );
      await client.query<Record<string, unknown>>(
        "UPDATE identity_providers SET name='changed' WHERE id='provider-a'"
      );
      await expect(
        verifyPostgresFamilyStagingRows({
          connectionString,
          targetId,
          skipDatasetIds: ['core.identity_accounts', 'core.passkeys'],
        })
      ).rejects.toThrow('aws_postgres_restore_invalid');
    });
  }
);

run('rolls back all Core rows and journal on cross-tenant source data', async () => {
  await withFamilyDatabase('core', async (connectionString, client) => {
    const source = backup('core', {
      'core.tenants': [tenantRow()],
      'core.identity_providers': [providerRow('tenant-b')],
    });
    await expect(
      restoreVerifiedPostgresFamily({
        backup: source,
        family: 'core',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString,
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
    expect(
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM tenants WHERE id='tenant-a'"
        )
      ).rows[0].count
    ).toBe(0);
    expect(
      (
        await client.query<{ marker: string | null }>(
          "SELECT to_regclass('authrim_aws_import_staging') AS marker"
        )
      ).rows[0].marker
    ).toBeNull();
  });
});

run('refuses an occupied tenant in a table outside the import allowlist', async () => {
  await withFamilyDatabase('core', async (connectionString, client) => {
    await client.query<Record<string, unknown>>(
      'CREATE TABLE extra_tenant_data (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)'
    );
    await client.query<Record<string, unknown>>(
      "INSERT INTO extra_tenant_data (id,tenant_id) VALUES ('old','tenant-a')"
    );
    await expect(
      restoreVerifiedPostgresFamily({
        backup: backup('core', { 'core.tenants': [tenantRow()] }),
        family: 'core',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString,
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
    expect(
      (
        await client.query<{ count: number }>(
          "SELECT count(*)::integer AS count FROM tenants WHERE id='tenant-a'"
        )
      ).rows[0].count
    ).toBe(0);
  });
});

run(
  'requires sourced account route generation and refuses unsupported nonempty SQL data',
  async () => {
    await withFamilyDatabase('core', async (connectionString, client) => {
      const account = row('core.identity_accounts', {
        id: t('account:alice'),
        tenant_id: t('tenant-a'),
        account_type: t('human'),
        lifecycle_state: t('active'),
        legacy_user_id: t('alice'),
        created_at: i(now),
        updated_at: i(now),
        directory_publication_state: t('active'),
        registration_state: t('registered'),
      });
      await expect(
        restoreVerifiedPostgresFamily({
          backup: backup('core', {
            'core.tenants': [tenantRow()],
            'core.identity_accounts': [account],
          }),
          family: 'core',
          tenantId: 'tenant-a',
          targetId: randomUUID(),
          connectionString,
        })
      ).rejects.toThrow('aws_postgres_restore_invalid');
      await expect(
        restoreVerifiedPostgresFamily({
          backup: backup(
            'core',
            { 'core.tenants': [tenantRow()] },
            {
              'core.unsupported_table': [{ id: t('unhandled') }],
            }
          ),
          family: 'core',
          tenantId: 'tenant-a',
          targetId: randomUUID(),
          connectionString,
        })
      ).rejects.toThrow('aws_postgres_restore_unsupported_datasets');
      expect(
        (
          await client.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM tenants WHERE id='tenant-a'"
          )
        ).rows[0].count
      ).toBe(0);
    });
  }
);

run('converts D1 JSON text to PII JSONB and keeps its target separate from Core', async () => {
  await withFamilyDatabase('pii', async (connectionString, client) => {
    const source = backup('pii', {
      'pii.users_pii': [
        row('pii.users_pii', {
          id: t('alice'),
          tenant_id: t('tenant-a'),
          pii_class: t('PROFILE'),
          email: t('alice@example.test'),
          custom_attributes_json: t('{"z":1,"a":true}'),
          created_at: i(now),
          updated_at: i(now),
        }),
      ],
      'pii.identity_sensitive_values': [
        row('pii.identity_sensitive_values', {
          id: t('sensitive-a'),
          tenant_id: t('tenant-a'),
          owner_type: t('user'),
          owner_id: t('alice'),
          value_key: t('name'),
          value_json: t('{"given":"Alice"}'),
          classification: t('sensitive'),
          lifecycle_state: t('active'),
          created_at: i(now),
          updated_at: i(now),
        }),
      ],
    });
    const targetId = randomUUID();
    const receipt = await restoreVerifiedPostgresFamily({
      backup: source,
      family: 'pii',
      tenantId: 'tenant-a',
      targetId,
      connectionString,
    });
    expect(receipt.tables.find((entry) => entry.datasetId === 'pii.users_pii')?.rowCount).toBe(1);
    expect(
      (
        await client.query<{ custom_attributes_json: unknown }>(
          "SELECT custom_attributes_json FROM users_pii WHERE id='alice'"
        )
      ).rows[0].custom_attributes_json
    ).toEqual({ a: true, z: 1 });
    expect(await readPostgresFamilyStagingReceipt({ connectionString, targetId })).toEqual(receipt);
    expect(await verifyPostgresFamilyStagingRows({ connectionString, targetId })).toEqual(receipt);
    await expect(
      verifyPostgresFamilyStagingRows({
        connectionString,
        targetId,
        skipDatasetIds: ['core.passkeys'],
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
  });
});

// The real D1 engine supplies trigger-generated rows and native storage tags.
interface LocalSqlite {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...values: (string | bigint | null)[]): unknown;
    setReadBigInts(enabled: boolean): void;
    all(...values: (string | bigint | null)[]): Array<Record<string, string | bigint | null>>;
  };
}
const sqliteModule = 'node:sqlite';
const { DatabaseSync } = (await import(sqliteModule)) as {
  DatabaseSync: new (path: string) => LocalSqlite;
};

async function actualSource(family: 'core' | 'pii', tenantId = 'tenant-a') {
  const db = new DatabaseSync(':memory:');
  try {
    const migrations = new URL(`../../../../../migrations/${family}/d1/`, import.meta.url);
    for (const file of freshInstallMigrationFiles(await readdir(migrations)))
      db.exec(
        renderPortableMigrationSql(await readFile(new URL(file, migrations), 'utf8'), 'sqlite')
      );
    const insert = (table: string, value: PortableSqliteRow) => {
      const columns = Object.keys(value);
      db.prepare(
        `INSERT INTO "${table}" (${columns.map((key) => `"${key}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      ).run(
        ...columns.map((key) =>
          value[key][0] === 'integer'
            ? BigInt(
                value[key][1] ??
                  (() => {
                    throw new Error('invalid_test_integer');
                  })()
              )
            : value[key][1]
        )
      );
    };
    if (family === 'core') {
      const initial = { 'core.tenants': [tenantRow()], ...personRows() };
      for (const [id, rows] of Object.entries(initial))
        for (const value of rows) {
          const replaced = Object.fromEntries(
            Object.entries(value).map(([key, tagged]) => [
              key,
              tagged[0] === 'text' && tagged[1] === 'tenant-a' ? t(tenantId) : tagged,
            ])
          );
          if (!(id === 'core.tenants' && tenantId === 'default')) insert(id.slice(5), replaced);
        }
      db.exec(`INSERT INTO legal_holds (id,tenant_id,subject_id,reason_code,created_by,created_at,updated_at)
        VALUES ('hold-a','${tenantId}','account:alice','litigation','operator-a',${now},${now});
        INSERT INTO roles (id,tenant_id,name,permissions_json,created_at) VALUES ('z-parent','${tenantId}','parent','[]',${now});
        INSERT INTO roles (id,tenant_id,name,permissions_json,created_at,parent_role_id) VALUES ('a-child','${tenantId}','child','[]',${now},'z-parent');
        INSERT INTO account_creation_operations
          (operation_id,tenant_id,actor_id,idempotency_key,allocation_idempotency_key,request_hash,user_id,account_id,status,created_at,completed_at,updated_at)
          VALUES ('creation-a','${tenantId}','operator-a','key-a','allocation-a','${'a'.repeat(64)}','alice','account:alice','succeeded',${now},${now},${now});
        INSERT INTO account_lifecycle_event_outbox
          (event_id,tenant_id,account_id,operation_id,event_type,payload_json,status,created_at,succeeded_at,updated_at)
          VALUES ('created-a','${tenantId}','account:alice','creation-a','account.created','{"account_id":"account:alice"}','pending',${now},NULL,${now});
        UPDATE account_lifecycle_event_outbox SET status='succeeded',succeeded_at=${now} WHERE event_id='created-a';
        INSERT INTO idempotency_keys
          (id,tenant_id,actor_id,method,path,idempotency_key,body_hash,response_status,response_body,created_at,expires_at)
          VALUES ('request-a','${tenantId}','operator-a','POST','/users','key-a','${'b'.repeat(64)}',201,'{"id":"alice"}',${now},${now + 1000});`);
    } else {
      db.prepare(
        `INSERT INTO users_pii (id,tenant_id,email,custom_attributes_json,created_at,updated_at)
        VALUES ('alice',?,'alice@example.test','{"precise":9007199254740993}',?,?)`
      ).run(tenantId, BigInt(now), BigInt(now));
      db.prepare(
        `INSERT INTO identity_sensitive_values
        (id,tenant_id,owner_type,owner_id,value_key,value_json,created_at,updated_at)
        VALUES ('value-a',?,'user','alice','name','{"precise":9007199254740993}',?,?)`
      ).run(tenantId, BigInt(now), BigInt(now));
    }
    const rows: Record<string, PortableSqliteRow[]> = {};
    const extensions: Record<string, PortableSqliteRow[]> = {};
    for (const spec of [
      ...POSTGRES_RESTORE_TABLE_CONTRACTS,
      ...POSTGRES_RESTORE_EXTENSION_CONTRACTS,
    ].filter((spec) => spec.family === family)) {
      const info = db.prepare(`PRAGMA table_info("${spec.table}")`);
      info.setReadBigInts(true);
      const columns = info.all();
      expect(columns.map((column) => String(column.name)).sort(), spec.datasetId).toEqual(
        [...spec.columns].sort()
      );
      expect(
        columns
          .filter((column) => typeof column.pk === 'bigint' && column.pk > 0n)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => String(column.name)),
        spec.datasetId
      ).toEqual(spec.primaryKey);
      const stmt = db.prepare(
        `SELECT * FROM "${spec.table}" WHERE "${spec.tenantColumn}"=? ORDER BY ${spec.primaryKey.map((key) => `"${key}"`).join(',')}`
      );
      stmt.setReadBigInts(true);
      const values = stmt.all(tenantId).map(
        (value) =>
          Object.fromEntries(
            spec.columns.map((key) => {
              const cell = value[key];
              return [
                key,
                cell === null
                  ? ['null', null]
                  : typeof cell === 'bigint'
                    ? ['integer', String(cell)]
                    : ['text', cell],
              ];
            })
          ) as PortableSqliteRow
      );
      (POSTGRES_RESTORE_EXTENSION_CONTRACTS.includes(spec) ? extensions : rows)[spec.datasetId] =
        values;
    }
    const result = backup(family, rows, extensions);
    result.manifest.source.tenantId = tenantId;
    return { backup: result, rows, extensions };
  } finally {
    db.close();
  }
}

run(
  'restores real D1 trigger rows, creation bookkeeping and role hierarchy without duplicate effects',
  async () => {
    const source = await actualSource('core');
    await withFamilyDatabase('core', async (connectionString, client) => {
      const targetId = randomUUID();
      const receipt = await restoreVerifiedPostgresFamily({
        backup: source.backup,
        family: 'core',
        tenantId: 'tenant-a',
        targetId,
        connectionString,
      });
      expect(receipt.projectionVersion).toBe(2);
      expectPostgresRestoreReceiptTables(
        receipt,
        source.backup.manifest.datasets.map((dataset) => dataset.id)
      );
      expect(await verifyPostgresFamilyStagingRows({ connectionString, targetId })).toEqual(
        receipt
      );
      expect(
        (
          await client.query<Record<string, unknown>>(
            `SELECT projection_state,projection_generation FROM account_legal_hold_states WHERE account_id='account:alice'`
          )
        ).rows
      ).toEqual([{ projection_state: 'active', projection_generation: '2' }]);
      expect(
        (
          await client.query<Record<string, unknown>>(
            "SELECT parent_role_id FROM roles WHERE id='a-child'"
          )
        ).rows[0].parent_role_id
      ).toBe('z-parent');
      for (const id of [
        'core.account_creation_operations',
        'core.account_lifecycle_event_outbox',
        'core.idempotency_keys',
      ])
        expect(receipt.tables.find((table) => table.datasetId === id)?.rowCount).toBe(1);
      await expect(
        client.query(
          `UPDATE account_lifecycle_event_outbox SET status='pending' WHERE event_id='created-a'`
        )
      ).rejects.toThrow('invalid_account_lifecycle_event_status_transition');
      await expect(
        client.query(
          `UPDATE account_creation_operations SET status='preparing' WHERE operation_id='creation-a'`
        )
      ).rejects.toThrow('invalid_account_creation_operation_status_transition');
      const before = (
        await client.query<Record<string, unknown>>(
          `SELECT revision FROM service_group_inputs WHERE user_id='alice'`
        )
      ).rows[0].revision as string;
      const outbox = (
        await client.query<Record<string, unknown>>(
          'SELECT count(*)::text AS count FROM account_webhook_outbox'
        )
      ).rows[0].count as string;
      await client.query<Record<string, unknown>>(
        `UPDATE identity_accounts SET metadata_json='{"last_login_at":1780000001000}' WHERE id='account:alice'`
      );
      expect(
        (
          await client.query<Record<string, unknown>>(
            `SELECT revision FROM service_group_inputs WHERE user_id='alice'`
          )
        ).rows[0].revision
      ).toBe(String(BigInt(before) + 1n));
      expect(
        (
          await client.query<Record<string, unknown>>(
            'SELECT count(*)::text AS count FROM account_webhook_outbox'
          )
        ).rows[0].count
      ).toBe(String(BigInt(outbox) + 1n));
      await expect(
        client.query<Record<string, unknown>>(
          `DELETE FROM identity_accounts WHERE id='account:alice'`
        )
      ).rejects.toThrow();
      expect(
        (
          await client.query<Record<string, unknown>>(
            `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'`
          )
        ).rows[0].n
      ).toBe(0);
    });
  }
);

run(
  'preserves exact JSONB beyond JavaScript integer precision and detects a one-unit mutation',
  async () => {
    const source = await actualSource('pii');
    await withFamilyDatabase('pii', async (connectionString, client) => {
      const targetId = randomUUID();
      await restoreVerifiedPostgresFamily({
        backup: source.backup,
        family: 'pii',
        tenantId: 'tenant-a',
        targetId,
        connectionString,
      });
      await verifyPostgresFamilyStagingRows({ connectionString, targetId });
      expect(
        (
          await client.query<Record<string, unknown>>(
            `SELECT custom_attributes_json->>'precise' AS value FROM users_pii`
          )
        ).rows[0].value
      ).toBe('9007199254740993');
      await client.query<Record<string, unknown>>(
        `UPDATE users_pii SET custom_attributes_json='{"precise":9007199254740992}'`
      );
      await expect(verifyPostgresFamilyStagingRows({ connectionString, targetId })).rejects.toThrow(
        'aws_postgres_restore_invalid'
      );
    });
  }
);

run('replaces only attested fresh reference seeds for the actual default tenant', async () => {
  const source = await actualSource('core', 'default');
  await withFamilyDatabase('core', async (connectionString) => {
    const targetId = randomUUID();
    const receipt = await restoreVerifiedPostgresFamily({
      backup: source.backup,
      family: 'core',
      tenantId: 'default',
      targetId,
      connectionString,
    });
    expect(receipt.tenantId).toBe('default');
    expect(await verifyPostgresFamilyStagingRows({ connectionString, targetId })).toEqual(receipt);
  });
});

run('rolls back imported rows and suspended triggers on a missing role parent', async () => {
  const source = await actualSource('core');
  source.extensions['core.roles'][0] = {
    ...source.extensions['core.roles'][0],
    parent_role_id: t('missing-parent'),
  };
  const input = backup('core', source.rows, source.extensions);
  await withFamilyDatabase('core', async (connectionString, client) => {
    await expect(
      restoreVerifiedPostgresFamily({
        backup: input,
        family: 'core',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString,
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
    expect(
      (
        await client.query<Record<string, unknown>>(
          `SELECT count(*)::int AS n FROM identity_accounts`
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await client.query<Record<string, unknown>>(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'`
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await client.query<Record<string, unknown>>(
          `SELECT to_regclass('authrim_aws_import_staging') AS name`
        )
      ).rows[0].name
    ).toBeNull();
  });
});

it.each(['core.statement_consent_guards', 'core.statement_consent_admissions'])(
  'rejects source-only statement consent authority before opening a target: %s',
  async (datasetId) => {
    const source = backup('core', {}, { [datasetId]: [{ tenant_id: t('tenant-a') }] });
    expect(() => assertPostgresBackupProjectionSupported(source, 'core')).toThrow(
      UnsupportedPostgresBackupProjectionError
    );
    const clientFactory = vi.fn((): Client => {
      throw new Error('unexpected_target_open');
    });
    await expect(
      restoreVerifiedPostgresFamily({
        backup: source,
        family: 'core',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString: 'unused',
        clientFactory,
      })
    ).rejects.toThrow(UnsupportedPostgresBackupProjectionError);
    expect(clientFactory).not.toHaveBeenCalled();
  }
);

it('rejects unsupported nonempty profiles before opening a target and exposes names/counts only', async () => {
  const source = backup(
    'core',
    {},
    {
      'core.totp_secrets': [{ secret: t('sensitive-do-not-print') }],
      'core.webauthn_challenges': [],
    }
  );
  expect(() => assertPostgresBackupProjectionSupported(source, 'core')).toThrow(
    UnsupportedPostgresBackupProjectionError
  );
  try {
    assertPostgresBackupProjectionSupported(source, 'core');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'aws_postgres_restore_unsupported_datasets',
      datasets: [{ datasetId: 'core.totp_secrets', rowCount: 1 }],
    });
    expect(JSON.stringify(error)).not.toContain('sensitive-do-not-print');
  }
  const clientFactory = vi.fn();
  await expect(
    restoreVerifiedPostgresFamily({
      backup: source,
      family: 'core',
      tenantId: 'tenant-a',
      targetId: randomUUID(),
      connectionString: 'unused',
      clientFactory,
    })
  ).rejects.toThrow(UnsupportedPostgresBackupProjectionError);
  expect(clientFactory).not.toHaveBeenCalled();
});

run(
  'verifies cold-start after a real login and rejects projection rollback, deletion and unrelated appends',
  async () => {
    const [coreSource, piiSource] = await Promise.all([actualSource('core'), actualSource('pii')]);
    const combined: VerifiedTenantBackupV2 = {
      ...coreSource.backup,
      manifest: {
        ...coreSource.backup.manifest,
        datasets: [...coreSource.backup.manifest.datasets, ...piiSource.backup.manifest.datasets],
      },
      dataset(id) {
        return (id.startsWith('core.') ? coreSource.backup : piiSource.backup).dataset(id);
      },
    };
    await withFamilyDatabase('core', async (coreUrl, core) =>
      withFamilyDatabase('pii', async (piiUrl) => {
        const coreTargetId = randomUUID();
        const piiTargetId = randomUUID();
        await restoreVerifiedPostgresFamily({
          backup: combined,
          family: 'core',
          tenantId: 'tenant-a',
          targetId: coreTargetId,
          connectionString: coreUrl,
        });
        await restoreVerifiedPostgresFamily({
          backup: combined,
          family: 'pii',
          tenantId: 'tenant-a',
          targetId: piiTargetId,
          connectionString: piiUrl,
        });
        const stateDb = new Pool({ connectionString: coreUrl });
        try {
          const verify = () =>
            verifyActivatedDatabaseRows({
              backup: combined,
              core: { connectionString: coreUrl, targetId: coreTargetId },
              pii: { connectionString: piiUrl, targetId: piiTargetId },
              stateDb,
              readPasskeyCounters: async () => [
                { user_id: 'alice', credential_id: 'passkey-a', counter: '5' },
              ],
              activatedAtMs: now,
            });
          await verify();
          await core.query(
            `UPDATE identity_accounts SET metadata_json='{"last_login_at":1780000001000}',updated_at=1780000001000 WHERE id='account:alice'`
          );
          await verify();
          const verifyProjection = async () => {
            const accounts = (
              await core.query<Record<string, unknown>>('SELECT * FROM identity_accounts')
            ).rows;
            return verifyActivatedLoginProjections({
              backup: combined,
              core,
              accounts: new Map(accounts.map((row) => [String(row.id), row])),
              activatedAtMs: now,
            });
          };
          for (const sql of [
            `UPDATE service_group_inputs SET revision=revision-1 WHERE user_id='alice'`,
            `UPDATE service_group_inputs SET revision=revision+1 WHERE user_id='alice'`,
            `DELETE FROM account_webhook_outbox WHERE id=(SELECT id FROM account_webhook_outbox WHERE event_type='account.created' LIMIT 1)`,
            `UPDATE account_webhook_outbox SET attempts=1 WHERE event_type='account.created'`,
            `UPDATE account_webhook_outbox SET event_type='account.deleted' WHERE event_type='account.updated'`,
            `UPDATE account_webhook_outbox SET occurred_at=1 WHERE event_type='account.updated'`,
          ]) {
            await core.query('BEGIN');
            try {
              await core.query(sql);
              await expect(verifyProjection()).rejects.toThrow('aws_live_database_invalid');
            } finally {
              await core.query('ROLLBACK');
            }
          }
          await verify();
        } finally {
          await stateDb.end();
        }
      })
    );
  }
);

run(
  'checks every optional contract against both canonical SQL schemas and keeps native constraints active',
  async () => {
    for (const family of ['core', 'pii'] as const)
      await withFamilyDatabase(family, async (_url, client) => {
        for (const spec of POSTGRES_RESTORE_EXTENSION_CONTRACTS.filter(
          (item) => item.family === family
        )) {
          const columns = (
            await client.query<{ column_name: string; data_type: string }>(
              `SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
              [spec.table]
            )
          ).rows;
          expect(columns.map((row) => row.column_name).sort(), spec.datasetId).toEqual(
            [...spec.columns].sort()
          );
          expect(
            columns
              .filter((row) => ['integer', 'bigint', 'boolean'].includes(row.data_type))
              .map((row) => row.column_name)
              .sort(),
            spec.datasetId
          ).toEqual([...spec.sqliteIntegerColumns].sort());
          expect(
            columns
              .filter((row) => row.data_type === 'boolean')
              .map((row) => row.column_name)
              .sort(),
            spec.datasetId
          ).toEqual([...spec.postgresBooleanColumns].sort());
          expect(
            columns
              .filter((row) => row.data_type === 'jsonb')
              .map((row) => row.column_name)
              .sort(),
            spec.datasetId
          ).toEqual([...spec.postgresJsonbColumns].sort());
          const primary = (
            await client.query<{ column_name: string }>(
              `SELECT a.attname AS column_name FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,pos) ON true JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum WHERE i.indisprimary AND c.relname=$1 ORDER BY k.pos`,
              [spec.table]
            )
          ).rows;
          expect(
            primary.map((row) => row.column_name),
            spec.datasetId
          ).toEqual(spec.primaryKey);
        }
      });
  }
);

run(
  'rejects cross-tenant optional rows and contradictory active-hold projection without leaving data',
  async () => {
    for (const variant of ['tenant', 'hold'] as const) {
      const source = await actualSource('core');
      if (variant === 'tenant')
        source.extensions['core.account_creation_operations'][0] = {
          ...source.extensions['core.account_creation_operations'][0],
          tenant_id: t('tenant-b'),
        };
      else
        source.extensions['core.account_legal_hold_states'][0] = {
          ...source.extensions['core.account_legal_hold_states'][0],
          projection_state: t('inactive'),
          active_hold_id: ['null', null],
        };
      await withFamilyDatabase('core', async (connectionString, client) => {
        await expect(
          restoreVerifiedPostgresFamily({
            backup: backup('core', source.rows, source.extensions),
            family: 'core',
            tenantId: 'tenant-a',
            targetId: randomUUID(),
            connectionString,
          })
        ).rejects.toThrow('aws_postgres_restore_invalid');
        expect(
          (
            await client.query<Record<string, unknown>>(
              'SELECT count(*)::int AS n FROM identity_accounts'
            )
          ).rows[0].n
        ).toBe(0);
        expect(
          (
            await client.query<Record<string, unknown>>(
              `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'`
            )
          ).rows[0].n
        ).toBe(0);
      });
    }
  }
);

run(
  'refuses modified reference seeds and never replaces existing default-tenant business data',
  async () => {
    const source = await actualSource('core', 'default');
    await withFamilyDatabase('core', async (connectionString, client) => {
      await client.query(
        `UPDATE screens SET display_name='modified' WHERE id='screen-login-default'`
      );
      await expect(
        restoreVerifiedPostgresFamily({
          backup: source.backup,
          family: 'core',
          tenantId: 'default',
          targetId: randomUUID(),
          connectionString,
        })
      ).rejects.toThrow('aws_postgres_restore_seed_invalid');
      expect(
        (
          await client.query<{ name: string }>(
            `SELECT display_name AS name FROM screens WHERE id='screen-login-default'`
          )
        ).rows[0].name
      ).toBe('modified');
      expect(
        (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM identity_accounts'))
          .rows[0].n
      ).toBe(0);
    });
  }
);

run('retains foreign-key enforcement for historical account creation events', async () => {
  const source = await actualSource('core');
  source.extensions['core.account_lifecycle_event_outbox'][0] = {
    ...source.extensions['core.account_lifecycle_event_outbox'][0],
    account_id: t('missing-account'),
  };
  await withFamilyDatabase('core', async (connectionString, client) => {
    await expect(
      restoreVerifiedPostgresFamily({
        backup: backup('core', source.rows, source.extensions),
        family: 'core',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString,
      })
    ).rejects.toMatchObject({ code: '23503' });
    expect(
      (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM identity_accounts'))
        .rows[0].n
    ).toBe(0);
    expect(
      (
        await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled<>'O'`
        )
      ).rows[0].n
    ).toBe(0);
  });
});

it.each([
  'core.attribute_verifications',
  'core.user_verified_attributes',
  'core.oauth_client_consents',
])('reports incompatible nonempty dataset %s instead of guessing a conversion', (datasetId) => {
  const source = backup('core', {}, { [datasetId]: [{ id: t('record-a') }] });
  expect(() => assertPostgresBackupProjectionSupported(source, 'core')).toThrow(
    UnsupportedPostgresBackupProjectionError
  );
});

run('rejects duplicate JSON keys instead of changing their SQLite interpretation', async () => {
  const source = await actualSource('pii');
  source.rows['pii.users_pii'][0] = {
    ...source.rows['pii.users_pii'][0],
    custom_attributes_json: t('{"role":"user","role":"admin"}'),
  };
  await withFamilyDatabase('pii', async (connectionString, client) => {
    await expect(
      restoreVerifiedPostgresFamily({
        backup: backup('pii', source.rows, source.extensions),
        family: 'pii',
        tenantId: 'tenant-a',
        targetId: randomUUID(),
        connectionString,
      })
    ).rejects.toThrow('aws_postgres_restore_invalid');
    expect(
      (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM users_pii')).rows[0].n
    ).toBe(0);
  });
});
