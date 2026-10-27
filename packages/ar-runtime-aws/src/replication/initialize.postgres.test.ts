import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeReplicationAuthorityDatabase,
  readReplicationAuthoritySchema,
} from './initialize';

it('rejects changed schema source pins before opening a database connection', async () => {
  const connect = vi.fn();
  await expect(initializeReplicationAuthorityDatabase({ connect }, '0'.repeat(64))).rejects.toThrow(
    'replication_schema_source_changed'
  );
  expect(connect).not.toHaveBeenCalled();
});

const connectionString =
  process.env.AUTHRIM_AWS_TEST_DATABASE_URL ?? process.env.AUTHRIM_TEST_DATABASE_URL;
const caPath = process.env.AUTHRIM_TEST_DATABASE_CA;
(connectionString && caPath ? describe : describe.skip)(
  'dedicated replication initialization over native verified PostgreSQL TLS',
  () => {
    let admin: Pool;
    let pool: Pool;
    let database = '';
    let sourceSha256 = '';
    let ca = '';
    beforeAll(async () => {
      ca = await readFile(caPath ?? '', 'utf8');
      sourceSha256 = (await readReplicationAuthoritySchema()).digest;
      admin = new Pool({ connectionString, ssl: { ca, rejectUnauthorized: true } });
      expect(
        (
          await admin.query<{ ssl: boolean }>(
            'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
          )
        ).rows
      ).toEqual([{ ssl: true }]);
    });
    beforeEach(async () => {
      database = `replication_init_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(connectionString ?? '');
      url.pathname = `/${database}`;
      pool = new Pool({ connectionString: url.href, ssl: { ca, rejectUnauthorized: true } });
    });
    afterEach(async () => {
      await pool?.end();
      if (database) await admin.query(`DROP DATABASE "${database}"`);
      database = '';
    });
    afterAll(async () => {
      await admin?.end();
    });

    it('installs once on an empty database and verifies the exact source and schema on restart', async () => {
      const first = await initializeReplicationAuthorityDatabase(pool, sourceSha256);
      expect(first.schemaSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(await initializeReplicationAuthorityDatabase(pool, sourceSha256)).toEqual(first);
      expect(
        (await pool.query('SELECT source_sha256,schema_sha256 FROM authrim_replication_schema'))
          .rows
      ).toEqual([{ source_sha256: sourceSha256, schema_sha256: first.schemaSha256 }]);
      expect(
        (
          await pool.query(`SELECT count(*)::integer AS public_grants
        FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
        WHERE n.nspname='public' AND a.grantee=0`)
        ).rows
      ).toEqual([{ public_grants: 0 }]);
    });

    it.each(['table', 'empty-schema', 'pg-prefix-schema', 'function', 'default-grant'] as const)(
      'rejects an existing %s without touching existing data',
      async (kind) => {
        const commands = {
          table:
            "CREATE TABLE existing_data(value text); INSERT INTO existing_data VALUES ('keep-me')",
          'empty-schema': 'CREATE SCHEMA existing_application',
          'pg-prefix-schema': 'CREATE SCHEMA pgshadow',
          function: 'CREATE FUNCTION existing_fn() RETURNS integer LANGUAGE SQL AS $$SELECT 1$$',
          'default-grant': 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',
        };
        await pool.query(commands[kind]);
        await expect(initializeReplicationAuthorityDatabase(pool, sourceSha256)).rejects.toThrow(
          'replication_authority_initialization_failed'
        );
        expect(
          (
            await pool.query(
              "SELECT to_regclass('public.authrim_replication_authorities') AS table_name"
            )
          ).rows
        ).toEqual([{ table_name: null }]);
        if (kind === 'table')
          expect((await pool.query('SELECT value FROM existing_data')).rows).toEqual([
            { value: 'keep-me' },
          ]);
      }
    );

    it('does not initialize through an unencrypted connection even to the same local test database', async () => {
      const url = new URL(connectionString ?? '');
      url.pathname = `/${database}`;
      const plaintext = new Pool({ connectionString: url.href, ssl: false });
      try {
        await expect(
          initializeReplicationAuthorityDatabase(plaintext, sourceSha256)
        ).rejects.toThrow('replication_authority_initialization_failed');
        expect(
          (
            await pool.query(
              "SELECT to_regclass('public.authrim_replication_schema') AS table_name"
            )
          ).rows
        ).toEqual([{ table_name: null }]);
      } finally {
        await plaintext.end();
      }
    });

    it.each([
      'column',
      'function',
      'trigger',
      'rls',
      'policy',
      'grant',
      'schema-grant',
      'unrelated-table',
      'unrelated-schema',
      'pg-prefix-schema',
    ] as const)('rejects %s drift on repeated initialization', async (kind) => {
      await initializeReplicationAuthorityDatabase(pool, sourceSha256);
      const commands = {
        column: 'ALTER TABLE authrim_replication_permits ADD COLUMN unexpected text',
        function: 'CREATE FUNCTION unexpected_fn() RETURNS integer LANGUAGE SQL AS $$SELECT 1$$',
        trigger: `CREATE FUNCTION unexpected_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
        CREATE TRIGGER unexpected BEFORE INSERT ON authrim_replication_permits FOR EACH ROW EXECUTE FUNCTION unexpected_trigger()`,
        rls: 'ALTER TABLE authrim_replication_permits ENABLE ROW LEVEL SECURITY',
        policy: 'CREATE POLICY unexpected ON authrim_replication_permits USING (true)',
        grant: 'GRANT SELECT ON authrim_replication_permits TO PUBLIC',
        'schema-grant': 'GRANT CREATE ON SCHEMA public TO PUBLIC',
        'unrelated-table': 'CREATE TABLE unrelated(value text)',
        'unrelated-schema': 'CREATE SCHEMA unrelated',
        'pg-prefix-schema': 'CREATE SCHEMA pgshadow',
      };
      await pool.query(commands[kind]);
      await expect(initializeReplicationAuthorityDatabase(pool, sourceSha256)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
      expect(
        (await pool.query('SELECT count(*)::integer AS count FROM authrim_replication_schema')).rows
      ).toEqual([{ count: 1 }]);
    });

    it('rejects a changed or ambiguous initialization receipt', async () => {
      await initializeReplicationAuthorityDatabase(pool, sourceSha256);
      await pool.query('UPDATE authrim_replication_schema SET source_sha256=$1', ['f'.repeat(64)]);
      await expect(initializeReplicationAuthorityDatabase(pool, sourceSha256)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
      await pool.query('UPDATE authrim_replication_schema SET source_sha256=$1', [sourceSha256]);
      await pool.query(
        'INSERT INTO authrim_replication_schema SELECT * FROM authrim_replication_schema'
      );
      await expect(initializeReplicationAuthorityDatabase(pool, sourceSha256)).rejects.toThrow(
        'replication_authority_initialization_failed'
      );
    });
  }
);
