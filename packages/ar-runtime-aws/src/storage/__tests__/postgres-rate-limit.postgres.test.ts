import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PostgresRateLimitStore } from '../postgres-rate-limit';
import type { PostgresQueryClient } from '../postgres-transient-state';

type TestPgClient = {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  end(): Promise<void>;
};

const databaseUrl = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.AUTHRIM_AWS_TEST_DATABASE_URL;

/** Exercises the actual concurrent PostgreSQL upsert in an isolated disposable schema. */
(databaseUrl ? it : it.skip)(
  'atomically limits concurrent Lambda requests by tenant and reset window',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    const schema = `aws_rate_limit_test_${randomUUID().replaceAll('-', '')}`;
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
        await readFile(new URL('../rate-limit-schema.sql', import.meta.url), 'utf8')
      );

      const storeA = new PostgresRateLimitStore(first as unknown as PostgresQueryClient);
      const storeB = new PostgresRateLimitStore(second as unknown as PostgresQueryClient);
      const request = {
        tenantId: 'tenant-a',
        key: 'tenant:tenant-a:rate-limit:loginStart:203.0.113.7',
        windowSeconds: 60,
        maxRequests: 2,
      };
      const results = await Promise.all([
        storeA.check(request),
        storeB.check(request),
        storeA.check(request),
      ]);
      expect(results.filter((result) => result.allowed)).toHaveLength(2);
      expect(results.filter((result) => !result.allowed)).toHaveLength(1);
      expect(results[2]?.remaining).toBeGreaterThanOrEqual(0);
      expect(await storeB.check({ ...request, tenantId: 'tenant-b' })).toMatchObject({
        allowed: true,
        remaining: 1,
      });

      const rows = await first.query(
        'SELECT key_hash FROM authrim_aws_rate_limit_counters WHERE scope_id = $1',
        ['tenant-a']
      );
      expect(rows.rows).toHaveLength(1);
      expect(String((rows.rows[0] as { key_hash: string }).key_hash)).not.toContain('203.0.113.7');

      await first.query(
        `UPDATE authrim_aws_rate_limit_counters
         SET reset_at_s = floor(extract(epoch from clock_timestamp()))::bigint - 1
         WHERE scope_id = $1`,
        ['tenant-a']
      );
      expect(await storeA.check(request)).toMatchObject({ allowed: true, remaining: 1 });
      await first.query(
        `UPDATE authrim_aws_rate_limit_counters
         SET reset_at_s = floor(extract(epoch from clock_timestamp()))::bigint - 1`
      );
      expect(await storeA.pruneExpired()).toBe(2);
    } finally {
      if (firstConnected && schemaCreated) {
        await first.query('SET search_path TO public');
        await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      if (secondConnected) await second.end();
      if (firstConnected) await first.end();
    }
  }
);
