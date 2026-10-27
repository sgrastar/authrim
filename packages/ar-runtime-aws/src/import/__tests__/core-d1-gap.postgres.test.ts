import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/src/migrations/sql-portability';

type TestPgClient = {
  connect(): Promise<void>;
  query<T = unknown>(
    sql: string,
    values?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

function databaseConnectionString(name: string): string {
  if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

const coreMigrations = new URL('../../../../../migrations/core/postgresql/', import.meta.url);

(databaseUrl ? it : it.skip)(
  'the migrated Core configuration tables remain tenant-scoped on PostgreSQL',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const databaseName = `aws_gap_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Client({ connectionString: databaseUrl });
    const core = new Client({ connectionString: databaseConnectionString(databaseName) });
    let adminConnected = false;
    let databaseCreated = false;
    let coreConnected = false;
    try {
      await admin.connect();
      adminConnected = true;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      databaseCreated = true;
      await core.connect();
      coreConnected = true;

      const filenames = (await readdir(coreMigrations))
        .filter((name) => /^\d+.*\.sql$/u.test(name))
        .sort();
      for (const filename of filenames) {
        // The existing baseline leaves search_path empty; the migration executor restores it
        // before every later delta. This harness follows that contract explicitly.
        await core.query('SET search_path TO public');
        const sql = await readFile(new URL(filename, coreMigrations), 'utf8');
        await core.query(renderPortableMigrationSql(sql, 'postgres'));
      }
      await core.query('SET search_path TO public');

      const now = Date.now();
      for (const tenantId of ['tenant-a', 'tenant-b']) {
        await core.query(
          `INSERT INTO tenants (id,tenant_code,tenant_key,name,is_default,created_at,updated_at)
             VALUES ($1,$1,$1,$1,FALSE,$2,$2)`,
          [tenantId, now]
        );
        await core.query(
          `INSERT INTO oauth_clients
             (tenant_id,client_id,client_name,redirect_uris,grant_types,response_types,
              application_type,allowed_channels,created_at,updated_at)
           VALUES ($1,'login-ui','Login UI','[]','["authorization_code"]','["code"]',
                   'web','["browser"]',$2,$2)`,
          [tenantId, now]
        );
        await core.query(
          `INSERT INTO identity_providers
             (id,tenant_id,name,provider_type,config_json,enabled,created_at,updated_at)
           VALUES ($1,$2,'Shared SP','saml_sp',$3,1,$4,$4)`,
          [
            `provider-${tenantId}`,
            tenantId,
            JSON.stringify({ entityId: 'https://sp.example.test/metadata', tenantId }),
            now,
          ]
        );
        await core.query(
          `INSERT INTO web_origin_registry
             (id,tenant_id,client_id,origin,handoff_allowed,created_at,updated_at)
           VALUES ($1,$2,'login-ui','https://idp.example.test',1,$3,$3)`,
          [`origin-${tenantId}`, tenantId, now]
        );
      }

      const clientA = await core.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM oauth_clients WHERE tenant_id=$1 AND client_id='login-ui'`,
        ['tenant-a']
      );
      const clientB = await core.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM oauth_clients WHERE tenant_id=$1 AND client_id='login-ui'`,
        ['tenant-b']
      );
      expect(clientA.rows).toEqual([{ tenant_id: 'tenant-a' }]);
      expect(clientB.rows).toEqual([{ tenant_id: 'tenant-b' }]);
      await core.query("UPDATE identity_providers SET enabled=0 WHERE tenant_id='tenant-b'");
      const active = await core.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM identity_providers
          WHERE tenant_id=$1 AND provider_type='saml_sp' AND enabled=1`,
        ['tenant-a']
      );
      const disabled = await core.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM identity_providers
          WHERE tenant_id=$1 AND provider_type='saml_sp' AND enabled=1`,
        ['tenant-b']
      );
      expect(active.rows).toEqual([{ tenant_id: 'tenant-a' }]);
      expect(disabled.rows).toEqual([]);
      await expect(
        core.query(
          `INSERT INTO identity_providers
             (id,tenant_id,name,provider_type,config_json,enabled,created_at,updated_at)
           VALUES ('provider-duplicate','tenant-a','Duplicate','saml_sp',$1,1,$2,$2)`,
          [JSON.stringify({ entityId: 'https://sp.example.test/metadata' }), now]
        )
      ).rejects.toThrow();
      await core.query(
        `INSERT INTO identity_accounts
           (id,tenant_id,account_type,lifecycle_state,created_at,updated_at)
         VALUES ('existing-account','tenant-a','user','active',$1,$1)`,
        [now]
      );
      const existingGeneration = await core.query<{ account_route_generation: string | null }>(
        "SELECT account_route_generation FROM identity_accounts WHERE id='existing-account'"
      );
      expect(existingGeneration.rows[0].account_route_generation).toBeNull();
      await expect(
        core.query(
          `INSERT INTO oauth_clients
             (tenant_id,client_id,client_name,redirect_uris,grant_types,response_types,
              created_at,updated_at)
           VALUES ('tenant-a','login-ui','duplicate','[]','[]','[]',$1,$1)`,
          [now]
        )
      ).rejects.toThrow();
    } finally {
      if (coreConnected) await core.end();
      if (databaseCreated) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      if (adminConnected) await admin.end();
    }
  }
);
