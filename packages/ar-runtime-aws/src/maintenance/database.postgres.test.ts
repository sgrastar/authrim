import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import {
  DATABASE_FAMILIES,
  createMaintenanceSqlClient,
  initializeMaintenanceDatabases,
  loadMaintenanceMigrations,
  withMaintenanceLock,
  type DatabaseFamily,
  type MaintenanceDatabase,
} from './database';

const databaseUrl = process.env.AUTHRIM_AWS_MAINTENANCE_TEST_DATABASE_URL;
const postgresIt = databaseUrl ? it : it.skip;
postgresIt(
  'initializes and resumes via TLS with a PostgreSQL 17 nonsuperuser administrator',
  { timeout: 120_000 },
  async () => {
    if (!databaseUrl) throw new Error('maintenance_test_database_missing');
    const source = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname) ||
      source.searchParams.get('sslmode') !== 'verify-full'
    )
      throw new Error('maintenance_test_requires_local_tls');
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const initializationId = randomUUID();
    const administrator = `maint_admin_${suffix}`;
    const password = 'a'.repeat(43);
    const adminUrl = new URL(source);
    adminUrl.username = administrator;
    adminUrl.password = password;
    const targets = Object.fromEntries(
      DATABASE_FAMILIES.map((family) => {
        const name = `maint_${suffix}_${family}`;
        const url = new URL(source);
        url.pathname = `/${name}`;
        url.username = name;
        url.password = password;
        return [family, { name, user: name, password, connectionString: url.toString() }];
      })
    ) as Record<DatabaseFamily, MaintenanceDatabase>;
    const superuser = new Client({ connectionString: source.toString() });
    await superuser.connect();
    let administratorCreated = false;
    try {
      const version = await superuser.query<{ server_version: string }>('SHOW server_version');
      expect(version.rows[0]?.server_version.startsWith('17.')).toBe(true);
      await superuser.query(
        `CREATE ROLE "${administrator}" LOGIN PASSWORD '${password}' NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS`
      );
      administratorCreated = true;
      const migrations = Object.fromEntries(
        await Promise.all(
          DATABASE_FAMILIES.map(async (family) => [
            family,
            await loadMaintenanceMigrations(
              family,
              family === 'state'
                ? new URL('../', import.meta.url)
                : new URL('../../../../', import.meta.url)
            ),
          ])
        )
      ) as Parameters<typeof initializeMaintenanceDatabases>[0]['migrations'];
      const initialize = () =>
        withMaintenanceLock(adminUrl.toString(), initializationId, async (master) => {
          const authority = await master.query<{
            rolsuper: boolean;
            rolcreatedb: boolean;
            rolcreaterole: boolean;
          }>(
            'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user'
          );
          expect(authority.rows).toEqual([
            { rolsuper: false, rolcreatedb: true, rolcreaterole: true },
          ]);
          return initializeMaintenanceDatabases({
            master,
            initializationId,
            databases: targets,
            migrations,
          });
        });
      const first = await initialize();
      expect(first).toHaveLength(3);
      const core = createMaintenanceSqlClient(targets.core.connectionString);
      await core.connect();
      try {
        await core.query('CREATE TABLE rehearsal_preservation_marker (id text PRIMARY KEY)');
        await core.query("INSERT INTO rehearsal_preservation_marker VALUES ('preserve-me')");
      } finally {
        await core.end();
      }
      expect(await initialize()).toEqual(first);
      const after = createMaintenanceSqlClient(targets.core.connectionString);
      await after.connect();
      try {
        expect((await after.query('SELECT id FROM rehearsal_preservation_marker')).rows).toEqual([
          { id: 'preserve-me' },
        ]);
        const objects = await after.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables WHERE table_schema='public'
            AND table_name=ANY($1::text[]) ORDER BY table_name`,
          [['users_core', 'passkeys', 'oauth_clients', 'web_origin_registry']]
        );
        expect(objects.rows.map((row) => row.table_name)).toEqual([
          'oauth_clients',
          'passkeys',
          'users_core',
          'web_origin_registry',
        ]);
      } finally {
        await after.end();
      }
      const crossDatabase = new URL(targets.core.connectionString);
      crossDatabase.pathname = `/${targets.pii.name}`;
      const denied = createMaintenanceSqlClient(crossDatabase.toString());
      try {
        await expect(denied.connect()).rejects.toThrow(/permission denied for database/u);
      } finally {
        await denied.end();
      }
      await withMaintenanceLock(adminUrl.toString(), initializationId, async () => {
        await expect(
          withMaintenanceLock(adminUrl.toString(), initializationId, async () => undefined)
        ).rejects.toThrow('aws_database_maintenance_busy');
      });
      await expect(
        withMaintenanceLock(adminUrl.toString(), initializationId, (master) =>
          initializeMaintenanceDatabases({
            master,
            initializationId,
            databases: targets,
            migrations: { ...migrations, core: { ...migrations.core, digest: 'changed' } },
          })
        )
      ).rejects.toThrow('aws_database_initialization_invalid');
    } finally {
      // All names above were generated by this test; no other database is touched.
      for (const target of Object.values(targets)) {
        await superuser.query(`DROP DATABASE IF EXISTS "${target.name}"`);
        await superuser.query(`DROP ROLE IF EXISTS "${target.user}"`);
      }
      if (administratorCreated) await superuser.query(`DROP ROLE "${administrator}"`);
      await superuser.end();
    }
  }
);
