import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { PostgresQueryClient } from '../../storage/postgres-transient-state';
import {
  assertAwsRuntimeSchemaReady,
  bootstrapFreshAwsRuntimeSchema,
} from '../aws-schema-bootstrap';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

(databaseUrl ? it : it.skip)(
  'adds AWS state beside Core data and rejects existing AWS tables or functions without adding DDL',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const client = new Client({ connectionString: databaseUrl });
    const schema = `aws_bootstrap_test_${randomUUID().replaceAll('-', '')}`;
    let connected = false;
    let schemaCreated = false;
    try {
      await client.connect();
      connected = true;
      await client.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        `CREATE TABLE identity_accounts (
           tenant_id text NOT NULL, id text NOT NULL,
           PRIMARY KEY (tenant_id, id)
         )`
      );
      await client.query(
        `INSERT INTO identity_accounts (tenant_id, id) VALUES ('tenant-a', 'account:user-a')`
      );
      const db = client as unknown as PostgresQueryClient;
      await expect(assertAwsRuntimeSchemaReady(db)).rejects.toThrow(
        'aws_runtime_schema_incomplete'
      );

      // A prior function with the same name must not be left alongside a partially
      // installed set of AWS tables, even when its signature differs.
      await client.query(
        `CREATE FUNCTION authrim_aws_store_authorization_code()
           RETURNS integer LANGUAGE sql AS 'SELECT 1'`
      );
      await expect(bootstrapFreshAwsRuntimeSchema(db)).rejects.toThrow(
        'aws_runtime_schema_not_empty'
      );
      expect(
        (
          await client.query(
            `SELECT count(*)::integer AS count FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relname LIKE 'authrim_aws_%'`
          )
        ).rows
      ).toEqual([{ count: 0 }]);
      await client.query('DROP FUNCTION authrim_aws_store_authorization_code()');

      await bootstrapFreshAwsRuntimeSchema(db);
      await expect(assertAwsRuntimeSchemaReady(db)).resolves.toBeUndefined();
      expect(
        (await client.query(`SELECT id FROM identity_accounts WHERE tenant_id = 'tenant-a'`)).rows
      ).toEqual([{ id: 'account:user-a' }]);
      const beforeRetry = await client.query(
        `SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relname LIKE 'authrim_aws_%'
         ORDER BY c.relname`
      );
      await expect(bootstrapFreshAwsRuntimeSchema(db)).rejects.toThrow(
        'aws_runtime_schema_not_empty'
      );
      await expect(assertAwsRuntimeSchemaReady(db)).resolves.toBeUndefined();
      expect(
        (
          await client.query(
            `SELECT c.relname, c.relkind FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema() AND c.relname LIKE 'authrim_aws_%'
             ORDER BY c.relname`
          )
        ).rows
      ).toEqual(beforeRetry.rows);
    } finally {
      if (schemaCreated) {
        await client.query('SET search_path TO public');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      if (connected) await client.end();
    }
  }
);
