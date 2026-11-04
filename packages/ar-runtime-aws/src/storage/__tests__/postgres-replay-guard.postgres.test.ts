import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { PostgresReplayGuardStore } from '../postgres-replay-guard';
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
  'lets exactly one of concurrent Lambda presentations record a jti',
  async () => {
    if (!databaseUrl) throw new Error('AUTHRIM_AWS_TEST_DATABASE_URL is required');
    const moduleName = 'pg';
    const { Client } = (await import(moduleName)) as unknown as {
      Client: new (options: { connectionString: string }) => TestPgClient;
    };
    const first = new Client({ connectionString: databaseUrl });
    const second = new Client({ connectionString: databaseUrl });
    const schema = `aws_replay_guard_test_${randomUUID().replaceAll('-', '')}`;
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
        await readFile(new URL('../replay-guard-schema.sql', import.meta.url), 'utf8')
      );

      const storeA = new PostgresReplayGuardStore(first as unknown as PostgresQueryClient);
      const storeB = new PostgresReplayGuardStore(second as unknown as PostgresQueryClient);
      const input = { tenantId: 'tenant-a', key: 'dpop:["client","raced"]', ttlSeconds: 60 };
      const results = await Promise.all([
        storeA.record(input),
        storeB.record(input),
        storeA.record(input),
        storeB.record(input),
      ]);
      expect(results.filter((result) => result === 'recorded')).toHaveLength(1);
      expect(await storeB.isRecorded(input)).toBe(true);
      expect(await storeA.record({ ...input, tenantId: 'tenant-b' })).toBe('recorded');

      await first.query(
        `UPDATE authrim_aws_replay_jtis
         SET expires_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint - 1
         WHERE tenant_id = $1`,
        ['tenant-a']
      );
      expect(await storeA.isRecorded(input)).toBe(false);
      expect(await storeB.record(input)).toBe('recorded');
      expect(await storeA.record(input)).toBe('replayed');

      await first.query(
        `UPDATE authrim_aws_replay_jtis
         SET expires_at_ms = (extract(epoch from clock_timestamp()) * 1000)::bigint - 1`
      );
      expect(await storeA.pruneExpired()).toBe(2);
    } finally {
      if (schemaCreated) await first.query(`DROP SCHEMA "${schema}" CASCADE`);
      if (secondConnected) await second.end();
      if (firstConnected) await first.end();
    }
  }
);
