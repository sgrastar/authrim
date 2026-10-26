import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  createSAMLPersistentNameIDRegistryKV,
  PostgresPersistentNameIDRegistry,
} from '../postgres-persistent-nameid';
import type { PostgresQueryClient } from '../postgres-transient-state';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

(databaseUrl ? it : it.skip)(
  'keeps persistent NameIDs stable under concurrent writes',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    const schema = `aws_nameid_test_${randomUUID().replaceAll('-', '')}`;
    let firstConnected = false;
    let secondConnected = false;
    let schemaCreated = false;
    try {
      await first.connect();
      firstConnected = true;
      await second.connect();
      secondConnected = true;
      await first.query(`CREATE SCHEMA "${schema}"`);
      schemaCreated = true;
      await first.query(`SET search_path TO "${schema}"`);
      await second.query(`SET search_path TO "${schema}"`);
      await first.query(
        await readFile(new URL('../persistent-nameid-schema.sql', import.meta.url), 'utf8')
      );

      const one = new PostgresPersistentNameIDRegistry(first as unknown as PostgresQueryClient);
      const two = new PostgresPersistentNameIDRegistry(second as unknown as PostgresQueryClient);
      const key =
        'saml:persistent-nameid:tenant:tenant-a:sp:https%3A%2F%2Fsp.example.test%2Fsaml:subject:user-a';
      const record = (createdAt: number, nameId = 'stable-nameid') =>
        JSON.stringify({
          version: 1,
          tenantId: 'tenant-a',
          spEntityId: 'https://sp.example.test/saml',
          subjectId: 'user-a',
          nameId,
          createdAt,
        });
      const contenders = await Promise.allSettled([
        one.put({ tenantId: 'tenant-a', key, value: record(1000) }),
        two.put({ tenantId: 'tenant-a', key, value: record(1001) }),
      ]);
      expect(contenders.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      expect(contenders.filter((value) => value.status === 'rejected')).toHaveLength(1);
      const saved = await two.get({ tenantId: 'tenant-a', key });
      expect(saved === record(1000) || saved === record(1001)).toBe(true);
      if (saved === null) throw new Error('persistent NameID was not stored');
      await one.put({ tenantId: 'tenant-a', key, value: saved });
      await expect(one.put({ tenantId: 'tenant-a', key, value: record(1002) })).rejects.toThrow(
        'aws_persistent_nameid_conflict'
      );
      expect(await two.get({ tenantId: 'tenant-a', key })).toBe(saved);
      await expect(two.get({ tenantId: 'tenant-b', key })).rejects.toThrow(
        'aws_persistent_nameid_invalid'
      );
      await expect(
        one.put({ tenantId: 'tenant-a', key, value: record(1000, 'changed-nameid') })
      ).rejects.toThrow('aws_persistent_nameid_conflict');
      const kv = createSAMLPersistentNameIDRegistryKV(one);
      expect(await kv.get(key)).toBe(saved);
      await expect(kv.put(key, saved, { expirationTtl: 60 })).rejects.toThrow(
        'aws_persistent_nameid_ttl_unsupported'
      );
    } finally {
      if (schemaCreated) {
        await first.query('SET search_path TO public');
        await first.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
      if (secondConnected) await second.end();
      if (firstConnected) await first.end();
    }
  }
);
