import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import type { PortableSqliteRow } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/src/migrations/sql-portability';
import type { VerifiedTenantBackupV2 } from '../backup-reader';
import {
  readPostgresFamilyStagingReceipt,
  restoreVerifiedPostgresFamily,
  type PostgresFamilyStagingReceiptRow,
  validatePostgresFamilyStagingReceiptRow,
  verifyPostgresFamilyStagingRows,
} from '../postgres-restore';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../postgres-restore-table-contract';

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
      for (const file of (await readdir(migrations))
        .filter((name) => /^\d+.*\.sql$/u.test(name))
        .sort()) {
        await client.query('SET search_path TO public');
        await client.query(
          renderPortableMigrationSql(await readFile(new URL(file, migrations), 'utf8'), 'postgres')
        );
      }
      await client.query('SET search_path TO public');
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
      await client.query(
        "UPDATE identity_accounts SET updated_at=updated_at+1 WHERE id='account:alice'"
      );
      await client.query("UPDATE passkeys SET counter=counter+1 WHERE user_id='alice'");
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
      await client.query(
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
      await client.query("DELETE FROM tenants WHERE id='tenant-b'");
      expect(
        (await client.query('SELECT tenant_id, client_id FROM web_origin_registry')).rows
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
      await client.query("UPDATE identity_providers SET name='changed' WHERE id='provider-a'");
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
    await client.query(
      'CREATE TABLE extra_tenant_data (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL)'
    );
    await client.query("INSERT INTO extra_tenant_data (id,tenant_id) VALUES ('old','tenant-a')");
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
      ).rejects.toThrow('aws_postgres_restore_invalid');
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
