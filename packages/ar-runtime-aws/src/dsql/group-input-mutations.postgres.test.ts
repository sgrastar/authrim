import { readMigrationSource } from '../../../../test/helpers/migration-source.mjs';
import { logProducerFixture } from '../../../../test/helpers/log-iceberg-producer-fixture.mjs';
import { PostgresAdapter } from '@authrim/ar-lib-core';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginGroupInputBoundary,
  settleGroupInputBoundary,
  type DatabaseAdapter,
  type TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { withGroupInputWrite } from '@authrim/ar-lib-core/services/dynamic-groups/write-boundary';
import { SavedGroupInputReader } from '@authrim/ar-lib-core/services/dynamic-groups/inputs';
import { AuroraDsqlAdapter } from './adapter';
import {
  createDsqlGroupBoundarySchemaPlan,
  createDsqlGroupInputMutations,
} from './group-input-mutations';
import { createDsqlIdentityProtectionSchemaPlan } from './protected-identity-mutations';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip).each(['native-postgres', 'dsql-explicit'] as const)(
  'group input boundaries (%s)',
  (mode) => {
    let schema: string;
    let pool: Pool;
    let db: AuroraDsqlAdapter;
    let adapter: DatabaseAdapter;
    let native: PostgresAdapter | undefined;
    let logs: Awaited<ReturnType<typeof logProducerFixture>>;
    const input = {
      id: 'boundary-a',
      tenantId: 'tenant-a',
      userId: 'user-a',
      operation: 'profile',
      createdAt: 2000,
    };
    beforeEach(async () => {
      logs = await logProducerFixture('scheduled', { separateAdmin: true });
      schema = `authrim_groups_${randomUUID().replaceAll('-', '')}`;
      pool = new Pool({
        connectionString: databaseUrl,
        max: 4,
        options: `-c search_path=${schema},public`,
      });
      db = new AuroraDsqlAdapter(
        {
          hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
          region: 'ap-northeast-1',
          user: 'admin',
        },
        {
          poolFactory: () => pool,
          sleep: async () => {},
          random: () => 0,
          ...(mode === 'dsql-explicit' ? { groupInputSchema: schema } : {}),
        }
      );
      await pool.query(`CREATE SCHEMA "${schema}"`);
      for (const table of createDsqlIdentityProtectionSchemaPlan(schema).tables)
        await pool.query(table.sql);
      for (const table of createDsqlGroupBoundarySchemaPlan(schema).tables)
        await pool.query(table.sql);
      await pool.query(`CREATE TABLE service_group_audit(id TEXT PRIMARY KEY,tenant_id TEXT,user_id TEXT,
      rule_version BIGINT,generation BIGINT,event_type TEXT,detail_json TEXT,created_at BIGINT);
      CREATE TABLE service_group_epoch(tenant_id TEXT PRIMARY KEY,revision BIGINT);
      CREATE TABLE synthetic_profile(id TEXT PRIMARY KEY,value TEXT)`);
      adapter = db;
      if (mode === 'native-postgres') {
        const sql = readMigrationSource(
          new URL('../../../../migrations/core/postgresql/', import.meta.url),
          '007_service_dynamic_groups.sql'
        );
        await pool.query(sql.slice(sql.indexOf('CREATE FUNCTION sg_write_boundary_insert_fn')));
        native = new PostgresAdapter({
          connectionString: databaseUrl,
          clientFactory: async () => {
            const owned = await pool.connect();
            return {
              async query<T>(sql: string, params?: unknown[]) {
                const result = await owned.query(sql, params);
                return {
                  rows: result.rows as T[],
                  rowCount: result.rowCount ?? result.rows.length,
                };
              },
              async end() {
                owned.release();
              },
            };
          },
        });
        adapter = native;
      }
    });
    afterEach(async () => {
      logs?.close();
      await native?.close();
      native = undefined;
      if (schema && pool) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db?.close();
    });
    const revision = async () =>
      Number(
        (await pool.query<{ revision: string }>('SELECT revision FROM service_group_inputs'))
          .rows[0]?.revision ?? 0
      );
    const reader = () =>
      new SavedGroupInputReader(
        adapter,
        adapter,
        adapter,
        'tenant-a',
        'user-a',
        undefined,
        logs.env
      );

    it('runs the existing write boundary and fences readers until both effects commit', async () => {
      const value = await withGroupInputWrite(
        adapter,
        'tenant-a',
        'user-a',
        'profile',
        async () => {
          expect(await revision()).toBe(1);
          await expect(reader().version()).rejects.toThrow('group_input_write_unsettled');
          await pool.query("INSERT INTO synthetic_profile VALUES ('user-a','changed')");
          return 'result';
        }
      );
      expect(value).toBe('result');
      expect(await revision()).toBe(2);
      expect((await pool.query('SELECT * FROM service_group_write_boundaries')).rows).toEqual([]);
      expect(await reader().version()).toMatchObject({ core: 2, pii: 2, metadata: 2 });
    });

    it('keeps partial cross-database writes fenced until explicit audited recovery', async () => {
      await expect(
        withGroupInputWrite(adapter, 'tenant-a', 'user-a', 'profile', async () => {
          await pool.query("INSERT INTO synthetic_profile VALUES ('user-a','partial')");
          throw new Error('synthetic cross-database failure');
        })
      ).rejects.toThrow('synthetic cross-database failure');
      const boundaries = (
        await pool.query<{ id: string; status: string }>(
          'SELECT id,status FROM service_group_write_boundaries'
        )
      ).rows;
      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].status).toBe('failed');
      expect(await revision()).toBe(1);
      await expect(reader().version()).rejects.toThrow('group_input_write_unsettled');
      await reader().acceptFailedWrites([boundaries[0].id], 'operator-a');
      expect(await revision()).toBe(2);
      const audit = await logs.rows('core.service_group_audit');
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        event_type: 'input_recovery',
        rule_version: 0,
        generation: 0,
      });
      expect(JSON.parse(String(audit[0].detail_json))).toEqual({
        actorId: 'operator-a',
        acceptedBoundaryIds: [boundaries[0].id],
      });
      expect(await logs.rows('core.service_group_audit', 'tenant-b')).toEqual([]);
      expect((await pool.query('SELECT * FROM service_group_audit')).rows).toEqual([]);
      expect((await pool.query('SELECT * FROM service_group_write_boundaries')).rows).toEqual([]);
      expect(await reader().version()).toMatchObject({ core: 2 });
    });

    it('never accepts an in-flight boundary or another tenant boundary', async () => {
      await beginGroupInputBoundary(adapter, input);
      await expect(reader().acceptFailedWrites([input.id], 'operator-a')).rejects.toThrow(
        'group_recovery_conflict'
      );
      await settleGroupInputBoundary(adapter, { ...input, tenantId: 'tenant-b' }, 'completed');
      expect(await revision()).toBe(1);
      expect((await pool.query('SELECT * FROM service_group_write_boundaries')).rows).toHaveLength(
        1
      );
    });

    it('rolls back the boundary if its revision cannot advance', async () => {
      await pool.query(
        'ALTER TABLE service_group_inputs ADD CONSTRAINT synthetic_failure CHECK(revision<1)'
      );
      await expect(beginGroupInputBoundary(adapter, input)).rejects.toMatchObject({
        code: '23514',
      });
      expect((await pool.query('SELECT * FROM service_group_write_boundaries')).rows).toEqual([]);
    });

    it('does not double invalidate when completion is retried', async () => {
      await beginGroupInputBoundary(adapter, input);
      await settleGroupInputBoundary(adapter, input, 'completed');
      await settleGroupInputBoundary(adapter, input, 'completed');
      expect(await revision()).toBe(2);
    });

    if (mode === 'dsql-explicit')
      it('reconciles lost begin acknowledgement from the exact scoped boundary', async () => {
        const capability = createDsqlGroupInputMutations(
          {
            query: db.query.bind(db),
            queryOne: db.queryOne.bind(db),
            execute: db.execute.bind(db),
            async retryableTransaction<T>(fn: (tx: TransactionContext) => Promise<T>) {
              await db.retryableTransaction(fn);
              throw new Error('lost');
            },
          },
          schema
        );
        await capability.begin(input);
        expect(await revision()).toBe(1);
        await expect(capability.begin({ ...input, tenantId: 'tenant-b' })).rejects.toThrow(
          'group_boundary_operation_conflict'
        );
        expect(await revision()).toBe(1);
      });
  }
);
