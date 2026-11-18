import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { ClientRepository, PostgresAdapter } from '@authrim/ar-lib-core';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
// Opt-in local PostgreSQL: two owned connections exercise the lock used by the atomic batch.
(databaseUrl ? describe : describe.skip)('client trust CAS on PostgreSQL', () => {
  it('keeps the winning activation and rejects the other batch without origin changes', async () => {
    const schema = `authrim_client_trust_${randomUUID().replaceAll('-', '')}`;
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      options: `-c search_path=${schema},public`,
    });
    const adapters: PostgresAdapter[] = [];
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE oauth_clients (tenant_id TEXT, client_id TEXT, enabled INTEGER,
        updated_at BIGINT, scope TEXT, PRIMARY KEY(tenant_id, client_id))`);
      await pool.query(`CREATE TABLE web_origin_registry (id TEXT, tenant_id TEXT, client_id TEXT, origin TEXT,
        cors_allowed INTEGER, csp_frame_ancestors TEXT, handoff_allowed INTEGER, iframe_allowed INTEGER,
        environment TEXT, is_active INTEGER, created_at BIGINT, updated_at BIGINT)`);
      await pool.query("INSERT INTO oauth_clients VALUES ('tenant-a','app',0,1000,'openid')");
      let reads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      for (let i = 0; i < 2; i++)
        adapters.push(
          new PostgresAdapter({
            connectionString: databaseUrl,
            clientFactory: async () => {
              const client = await pool.connect();
              return {
                async query<T>(sql: string, params?: unknown[]) {
                  const result = await client.query(sql, params);
                  if (sql.startsWith('SELECT * FROM oauth_clients') && ++reads <= 2) {
                    if (reads === 2) release();
                    await bothRead;
                  }
                  return {
                    rows: result.rows as T[],
                    rowCount: result.rowCount ?? result.rows.length,
                  };
                },
                async end() {
                  client.release();
                },
              };
            },
          })
        );
      const results = await Promise.all(
        adapters.map((adapter, i) =>
          new ClientRepository(adapter, 'tenant-a').update(
            'app',
            { enabled: i === 0, scope: i === 0 ? 'winner-a' : 'winner-b' },
            {
              expectedUpdatedAt: 1000,
              webOriginRegistry: { origins: [`https://writer-${i}.example`] },
            }
          )
        )
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      const current = (await pool.query<{ scope: string }>('SELECT scope FROM oauth_clients'))
        .rows[0];
      const origins = (
        await pool.query<{ origin: string }>('SELECT origin FROM web_origin_registry')
      ).rows;
      expect(origins).toEqual([
        {
          origin:
            current.scope === 'winner-a' ? 'https://writer-0.example' : 'https://writer-1.example',
        },
      ]);
    } finally {
      for (const adapter of adapters) await adapter.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
