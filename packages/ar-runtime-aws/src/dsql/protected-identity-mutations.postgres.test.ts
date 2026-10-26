import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordCanonicalLastLogin,
  type DatabaseAdapter,
  type TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { CanonicalRuntimeUserStore, PostgresAdapter } from '@authrim/ar-lib-core';
import { AuroraDsqlAdapter } from './adapter';
import {
  createDsqlIdentityProtectionSchemaPlan,
  createDsqlProtectedIdentityMutations,
} from './protected-identity-mutations';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

// Real local SQL/transaction tests. No claim of AWS DSQL service compatibility is made here.
(databaseUrl ? describe : describe.skip).each(['native-postgres', 'dsql-explicit'] as const)(
  'protected identity mutation (%s effects)',
  (mode) => {
    let pool: Pool;
    let db: AuroraDsqlAdapter;
    let adapter: DatabaseAdapter;
    let native: PostgresAdapter | undefined;
    let schema: string;
    let store: CanonicalRuntimeUserStore;
    const input = {
      tenantId: 'tenant-a',
      userId: 'user-a',
      accountId: 'account-a',
      operationId: 'login-a',
      observedAtMs: 2000,
    };

    beforeEach(async () => {
      schema = `authrim_mutation_${randomUUID().replaceAll('-', '')}`;
      pool = new Pool({
        connectionString: databaseUrl,
        max: 6,
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
          ...(mode === 'dsql-explicit' ? { protectedIdentitySchema: schema } : {}),
        }
      );
      await pool.query(`CREATE SCHEMA "${schema}"`);
      // Deliberately minimal identity fixture; production identity/FK schema is a separate contract.
      await pool.query(`CREATE TABLE identity_accounts (
        id TEXT PRIMARY KEY, tenant_id TEXT, legacy_user_id TEXT, account_type TEXT,
        lifecycle_state TEXT, directory_publication_state TEXT, registration_state TEXT,
        display_label TEXT, metadata_json TEXT, updated_at BIGINT, deleted_at BIGINT)`);
      const plan = createDsqlIdentityProtectionSchemaPlan(schema);
      for (const table of plan.tables) await pool.query(table.sql);
      for (const index of plan.indexes)
        await pool.query(index.sql.replace(' INDEX ASYNC ', ' INDEX '));
      await pool.query(`INSERT INTO identity_accounts VALUES
        ('account-a','tenant-a','user-a','user','active','active','registered','original',
        '{"precise":9007199254740993,"other":"keep"}',1000,NULL)`);
      adapter = db;
      if (mode === 'native-postgres') {
        for (const [file, name, trigger] of [
          [
            '005_account_webhook_outbox',
            'authrim_account_webhook_updated',
            'account_webhook_updated',
          ],
          [
            '007_service_dynamic_groups',
            'sg_identity_accounts_update_fn',
            'sg_identity_accounts_update',
          ],
        ]) {
          const sql = readFileSync(
            new URL(`../../../../migrations/core/postgresql/${file}.sql`, import.meta.url),
            'utf8'
          );
          const start = sql.indexOf(`CREATE FUNCTION ${name}(`);
          const end = sql.indexOf(';', sql.indexOf(`CREATE TRIGGER ${trigger} `, start)) + 1;
          await pool.query(
            sql.slice(start, end).replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '2000')
          );
        }
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
      store = new CanonicalRuntimeUserStore({
        coreAdapter: adapter,
        piiAdapter: adapter,
        tenantId: 'tenant-a',
      });
    });
    afterEach(async () => {
      await native?.close();
      native = undefined;
      if (schema && pool) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await db?.close();
    });
    const account = async () =>
      (
        await pool.query<{
          metadata_json: string;
          lifecycle_state: string;
          display_label: string;
          updated_at: string;
        }>('SELECT * FROM identity_accounts')
      ).rows[0];
    const effects = async () => ({
      outbox: (
        await pool.query<{ event_type: string; changed_field: string }>(
          'SELECT event_type,changed_field FROM account_webhook_outbox'
        )
      ).rows,
      revisions: (
        await pool.query<{ revision: number }>(
          'SELECT revision::integer AS revision FROM service_group_inputs'
        )
      ).rows,
    });

    it('runs through the shared runtime store and preserves unrelated precise JSON with exactly one effect', async () => {
      expect(await store.touchLastLogin('user-a', 2000)).toBe(true);
      expect(await store.touchLastLogin('user-a', 1999)).toBe(false);
      expect((await account()).metadata_json).toContain('9007199254740993');
      expect(JSON.parse((await account()).metadata_json)).toMatchObject({
        last_login_at: 2000,
        other: 'keep',
      });
      expect(await effects()).toEqual({
        outbox: [{ event_type: 'account.updated', changed_field: 'account' }],
        revisions: [{ revision: 1 }],
      });
    });

    it('leaves suspension and concurrent metadata unchanged after a stale repository read', async () => {
      const original = adapter.queryOne.bind(adapter);
      vi.spyOn(adapter, 'queryOne').mockImplementationOnce(async (sql, params, options) => {
        const stale = await original(sql, params, options);
        await pool.query(
          "UPDATE identity_accounts SET lifecycle_state='suspended',display_label='changed',updated_at=3000"
        );
        return stale;
      });
      expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
      expect(await account()).toMatchObject({
        lifecycle_state: 'suspended',
        display_label: 'changed',
        updated_at: '3000',
      });
      expect((await account()).metadata_json).not.toContain('last_login_at');
    });

    it('keeps the maximum timestamp when two successful observations race', async () => {
      await Promise.all([2000, 3000].map((time) => store.touchLastLogin('user-a', time)));
      expect(
        (JSON.parse((await account()).metadata_json) as Record<string, unknown>).last_login_at
      ).toBe(3000);
      const result = await effects();
      expect(result.outbox.length).toBeGreaterThanOrEqual(1);
      expect(result.outbox.length).toBeLessThanOrEqual(2);
      expect(result.revisions[0].revision).toBe(result.outbox.length);
    });

    it('rolls back the user update and group input if outbox insertion fails', async () => {
      await pool.query(
        "ALTER TABLE account_webhook_outbox ADD CONSTRAINT synthetic_failure CHECK(event_type <> 'account.updated')"
      );
      await expect(store.touchLastLogin('user-a', 2000)).rejects.toMatchObject({ code: '23514' });
      expect((await account()).metadata_json).not.toContain('last_login_at');
      expect(await effects()).toEqual({ outbox: [], revisions: [] });
      expect((await pool.query('SELECT * FROM authrim_identity_mutation_receipts')).rows).toEqual(
        []
      );
    });

    it.each([{ tenantId: 'tenant-b' }, { accountId: 'account-b' }, { userId: 'user-b' }])(
      'does not cross identity scope %j',
      async (patch) => {
        expect(await recordCanonicalLastLogin(adapter, { ...input, ...patch })).toBe(false);
        expect(await effects()).toEqual({ outbox: [], revisions: [] });
      }
    );

    it.each(['suspended', 'deleting', 'deleted'])('does not write %s accounts', async (state) => {
      await pool.query('UPDATE identity_accounts SET lifecycle_state=$1', [state]);
      expect(await store.touchLastLogin('user-a', 2000)).toBe(false);
      expect((await account()).metadata_json).not.toContain('last_login_at');
    });

    if (mode === 'dsql-explicit') {
      it('returns the original receipt outcome on a repeated operation without duplicating effects', async () => {
        expect(await recordCanonicalLastLogin(adapter, input)).toBe(true);
        expect(await recordCanonicalLastLogin(adapter, input)).toBe(true);
        expect(await effects()).toEqual({
          outbox: [{ event_type: 'account.updated', changed_field: 'account' }],
          revisions: [{ revision: 1 }],
        });
      });

      it('rejects operation-ID reuse with altered input before any second mutation', async () => {
        await recordCanonicalLastLogin(adapter, input);
        await expect(
          recordCanonicalLastLogin(adapter, { ...input, observedAtMs: 3000 })
        ).rejects.toThrow('dsql_protected_identity_operation_conflict');
        expect(
          (JSON.parse((await account()).metadata_json) as Record<string, unknown>).last_login_at
        ).toBe(2000);
        expect((await effects()).outbox).toHaveLength(1);
      });

      it('reconciles a lost commit reply only from an exact durable receipt', async () => {
        let lost = 0;
        const capability = createDsqlProtectedIdentityMutations(
          {
            query: db.query.bind(db),
            queryOne: db.queryOne.bind(db),
            execute: db.execute.bind(db),
            async retryableTransaction<T>(fn: (tx: TransactionContext) => Promise<T>) {
              await db.retryableTransaction(fn);
              lost++;
              throw new Error('synthetic lost reply');
            },
          },
          schema
        );
        expect(await capability.recordLastLogin(input)).toBe(true);
        expect(lost).toBe(1);
        expect((await effects()).outbox).toHaveLength(1);
      });

      it('retries simultaneous duplicate operations to one receipt and one side effect', async () => {
        expect(
          await Promise.all([
            recordCanonicalLastLogin(adapter, input),
            recordCanonicalLastLogin(adapter, input),
          ])
        ).toEqual([true, true]);
        expect((await effects()).outbox).toHaveLength(1);
        expect(
          (await pool.query('SELECT * FROM authrim_identity_mutation_receipts')).rows
        ).toHaveLength(1);
      });

      it('rolls back all effects when the final receipt cannot be saved', async () => {
        await pool.query(
          "ALTER TABLE authrim_identity_mutation_receipts ADD CONSTRAINT synthetic_failure CHECK(operation_id <> 'login-a')"
        );
        await expect(recordCanonicalLastLogin(adapter, input)).rejects.toThrow(
          'aurora_dsql_operation_failed'
        );
        expect((await account()).metadata_json).not.toContain('last_login_at');
        expect(await effects()).toEqual({ outbox: [], revisions: [] });
      });
    }
  }
);
