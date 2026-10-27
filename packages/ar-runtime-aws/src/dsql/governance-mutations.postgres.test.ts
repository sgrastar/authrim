import { PostgresAdapter } from '@authrim/ar-lib-core';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createAccountLegalHold,
  releaseAccountLegalHold,
  transitionCanonicalAccountDeletion,
  putAccountSupportContext,
  type DatabaseAdapter,
  type CreateLegalHoldInput,
  type TransactionContext,
} from '@authrim/ar-lib-core/db/adapter';
import { CanonicalRuntimeUserWriter, CanonicalIdentityRepository } from '@authrim/ar-lib-core';
import { AuroraDsqlAdapter } from './adapter';
import { createDsqlIdentityProtectionSchemaPlan } from './protected-identity-mutations';
import { createDsqlGovernanceSchemaPlan } from './governance-schema';
import { createDsqlGovernanceMutations } from './governance-mutations';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;
// Tests native PostgreSQL effects against the explicit DSQL SQL contract. AWS support is a separate probe.
(databaseUrl ? describe : describe.skip).each(['native-postgres', 'dsql-explicit'] as const)(
  'governance operations (%s)',
  (mode) => {
    let schema: string;
    let events: string;
    let role: string | undefined;
    let pool: Pool;
    let db: AuroraDsqlAdapter;
    let adapter: DatabaseAdapter;
    let native: PostgresAdapter | undefined;
    let afterHoldInsert: (() => Promise<void>) | undefined;
    let begun = 0;
    const input: CreateLegalHoldInput = {
      tenantId: 'tenant-a',
      accountId: 'account-a',
      holdId: 'hold-a',
      eventId: 'event-a',
      operationId: 'op-a',
      actor: 'actor-a',
      reasonCode: 'case.open',
      caseReference: null,
      expiresAt: null,
      now: 2000,
    };
    beforeEach(async () => {
      afterHoldInsert = undefined;
      begun = 0;
      const suffix = randomUUID().replaceAll('-', '');
      schema = `authrim_governance_${suffix}`;
      events = `authrim_events_${suffix}`;
      pool = new Pool({
        connectionString: databaseUrl,
        max: 6,
        options: `-c search_path=${schema},${events},public`,
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
          ...(mode === 'dsql-explicit'
            ? { accountGovernanceSchemas: { core: schema, events } }
            : {}),
        }
      );
      await pool.query(`CREATE SCHEMA "${schema}"; CREATE SCHEMA "${events}"`);
      await pool.query(`CREATE TABLE identity_accounts (
      id TEXT PRIMARY KEY,tenant_id TEXT,legacy_user_id TEXT,account_type TEXT,lifecycle_state TEXT,
      directory_publication_state TEXT,registration_state TEXT,display_label TEXT,metadata_json TEXT,
      updated_at BIGINT,deleted_at BIGINT,primary_subject_id TEXT)`);
      for (const table of createDsqlIdentityProtectionSchemaPlan(schema).tables)
        await pool.query(table.sql);
      const plan = createDsqlGovernanceSchemaPlan(schema, events);
      for (const table of plan.tables) await pool.query(table.sql);
      for (const index of plan.indexes)
        await pool.query(index.sql.replace(' INDEX ASYNC ', ' INDEX '));
      if (mode === 'native-postgres') {
        const baseline = readFileSync(
          new URL(
            '../../../../migrations/core/postgresql/001_0_4_0_core_baseline.sql',
            import.meta.url
          ),
          'utf8'
        );
        for (const name of [
          'authrim_identity_account_legal_hold_state_insert',
          'authrim_legal_hold_projection_state_change',
          'authrim_legal_hold_validate_account',
          'authrim_legal_hold_validate_update',
          'authrim_legal_hold_event_immutable',
          'authrim_legal_hold_forbid_delete',
        ]) {
          const start = baseline.indexOf(`CREATE FUNCTION public.${name}(`);
          const end = baseline.indexOf('$$;', start) + 3;
          await pool.query(
            baseline.slice(start, end).replaceAll(`public.${name}`, `"${schema}".${name}`)
          );
          const triggers =
            baseline.match(
              new RegExp(`CREATE TRIGGER [^;]+EXECUTE FUNCTION public\\.${name}\\(\\);`, 'gu')
            ) ?? [];
          for (const sql of triggers)
            await pool.query(
              sql
                .replaceAll(`public.${name}`, `"${schema}".${name}`)
                .replaceAll('public.legal_hold_events', `"${events}".legal_hold_events`)
                .replaceAll('public.', `"${schema}".`)
            );
        }
        for (const [file, name, trigger] of [
          [
            '005_account_webhook_outbox',
            'authrim_account_webhook_deleted',
            'account_webhook_deleted',
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
            sql.slice(start, end).replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '3000')
          );
        }
        native = new PostgresAdapter({
          connectionString: databaseUrl,
          clientFactory: async () => {
            const owned = await pool.connect();
            return {
              async query<T>(sql: string, params?: unknown[]) {
                if (sql === 'BEGIN') begun++;
                const result = await owned.query(sql, params);
                if (/^\s*INSERT INTO legal_holds/u.test(sql) && afterHoldInsert)
                  await afterHoldInsert();
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
      } else adapter = db;
      await pool.query(
        `INSERT INTO identity_accounts VALUES ('account-a','tenant-a','user-a','user','active','active','registered','original','{}',1000,NULL,NULL)`
      );
      if (mode === 'dsql-explicit')
        await pool.query(
          "INSERT INTO account_legal_hold_states VALUES ('tenant-a','account-a',NULL,'inactive',1,1000)"
        );
    });
    afterEach(async () => {
      await native?.close();
      native = undefined;
      if (pool && schema)
        await pool.query(
          `DROP SCHEMA IF EXISTS "${events}" CASCADE; DROP SCHEMA IF EXISTS "${schema}" CASCADE`
        );
      if (role) await pool.query(`DROP ROLE "${role}"`);
      role = undefined;
      await db?.close();
    });
    const counts = async () =>
      (
        await pool.query<{ holds: number; events: number; outbox: number }>(`SELECT
    (SELECT count(*)::integer FROM legal_holds) AS holds,(SELECT count(*)::integer FROM legal_hold_events) AS events,
    (SELECT count(*)::integer FROM legal_hold_projection_outbox) AS outbox`)
      ).rows[0];
    const release = () =>
      releaseAccountLegalHold(adapter, {
        ...input,
        expectedVersion: 1,
        operationId: 'op-release',
        eventId: 'event-release',
        reasonCode: 'case.closed',
        now: 3000,
      });

    if (mode === 'native-postgres')
      it('keeps a concurrent deletion out of a hold transaction that later rolls back', async () => {
        await pool.query(
          "ALTER TABLE legal_hold_projection_outbox ADD CONSTRAINT synthetic_failure CHECK(operation_id<>'op-a')"
        );
        let signalEntered = () => {};
        let releaseInsert = () => {};
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve;
        });
        const release = new Promise<void>((resolve) => {
          releaseInsert = resolve;
        });
        afterHoldInsert = async () => {
          signalEntered();
          await release;
        };
        const holding = createAccountLegalHold(adapter, input);
        // Attach rejection observation before releasing the paused mutation.
        const failed = expect(holding).rejects.toMatchObject({ code: '23514' });
        await entered;
        const deleting = transitionCanonicalAccountDeletion(adapter, {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          state: 'deleting',
          now: 3000,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const concurrentBegins = begun;
        releaseInsert();
        await failed;
        expect(await deleting).toBe(true);
        expect(concurrentBegins).toBe(1);
        expect(await counts()).toEqual({ holds: 0, events: 0, outbox: 0 });
        expect((await pool.query('SELECT lifecycle_state FROM identity_accounts')).rows).toEqual([
          { lifecycle_state: 'deleting' },
        ]);
      });
    it('creates and releases an active hold with atomic authority, immutable history and delivery evidence', async () => {
      expect((await createAccountLegalHold(adapter, input))[0].rowsAffected).toBe(1);
      expect(await counts()).toEqual({ holds: 1, events: 1, outbox: 1 });
      expect(
        (
          await pool.query(
            'SELECT projection_state,projection_generation::integer AS generation FROM account_legal_hold_states'
          )
        ).rows[0]
      ).toEqual({ projection_state: 'active', generation: 2 });
      expect(
        await transitionCanonicalAccountDeletion(adapter, {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          state: 'deleting',
          now: 2500,
        })
      ).toBe(false);
      expect((await release())[0].rowsAffected).toBe(1);
      expect(await counts()).toEqual({ holds: 1, events: 2, outbox: 2 });
      expect(
        (
          await pool.query(
            'SELECT projection_state,projection_generation::integer AS generation FROM account_legal_hold_states'
          )
        ).rows[0]
      ).toEqual({ projection_state: 'inactive', generation: 3 });
      expect((await release())[0].rowsAffected).toBe(0);
      expect(await counts()).toEqual({ holds: 1, events: 2, outbox: 2 });
    });

    it('updates support context with version CAS, preserves its creator, and excludes another tenant', async () => {
      const support = {
        tenantId: 'tenant-a',
        accountId: 'account-a',
        actor: 'creator',
        expectedVersion: 0,
        contextJson: '{"schema_version":1,"external_references":[]}',
        now: 2000,
      };
      expect(
        (await putAccountSupportContext(adapter, { ...support, tenantId: 'tenant-b' })).rowsAffected
      ).toBe(0);
      expect((await putAccountSupportContext(adapter, support)).rowsAffected).toBe(1);
      expect(
        (
          await putAccountSupportContext(adapter, {
            ...support,
            actor: 'second',
            expectedVersion: 1,
            now: 3000,
          })
        ).rowsAffected
      ).toBe(1);
      expect(
        (await putAccountSupportContext(adapter, { ...support, expectedVersion: 1, now: 4000 }))
          .rowsAffected
      ).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT version::integer AS version,created_by,updated_by FROM account_support_contexts'
          )
        ).rows
      ).toEqual([{ version: 2, created_by: 'creator', updated_by: 'second' }]);
    });

    it('retains expired-but-unreleased holds and blocks the actual writer before any PII work', async () => {
      await createAccountLegalHold(adapter, { ...input, expiresAt: 2100 });
      const pii = {
        ...adapter,
        execute: async () => {
          throw new Error('PII must not be touched');
        },
        queryOne: async () => {
          throw new Error('PII must not be touched');
        },
      };
      const writer = new CanonicalRuntimeUserWriter(
        new CanonicalIdentityRepository(adapter, 'tenant-a'),
        pii
      );
      await expect(writer.deleteRuntimeUser('user-a')).rejects.toThrow(
        'account_deletion_not_admitted'
      );
      expect((await pool.query('SELECT lifecycle_state FROM identity_accounts')).rows[0]).toEqual({
        lifecycle_state: 'active',
      });
      expect(await counts()).toEqual({ holds: 1, events: 1, outbox: 1 });
    });

    it('never admits both a racing hold creation and account deletion', async () => {
      const outcomes = await Promise.allSettled([
        createAccountLegalHold(adapter, input),
        transitionCanonicalAccountDeletion(adapter, {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          state: 'deleting',
          now: 2001,
        }),
      ]);
      expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true);
      const row = (
        await pool.query<{ lifecycle_state: string; hold_count: number }>(`SELECT lifecycle_state,
      (SELECT count(*)::integer FROM legal_holds WHERE state='active') AS hold_count FROM identity_accounts`)
      ).rows[0];
      expect(row.lifecycle_state === 'deleting' && row.hold_count > 0).toBe(false);
      expect((await pool.query('SELECT * FROM legal_hold_events')).rows).toHaveLength(
        row.hold_count
      );
    });

    it('fails closed for a missing authority row and for a cross-tenant hold', async () => {
      expect(
        (await createAccountLegalHold(adapter, { ...input, tenantId: 'tenant-b' }))[0].rowsAffected
      ).toBe(0);
      await pool.query('DELETE FROM account_legal_hold_states');
      expect((await createAccountLegalHold(adapter, input))[0].rowsAffected).toBe(0);
      expect(
        await transitionCanonicalAccountDeletion(adapter, {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          state: 'deleted',
          now: 3000,
        })
      ).toBe(false);
      expect(await counts()).toEqual({ holds: 0, events: 0, outbox: 0 });
    });

    it('rolls back authority and hold when the event or outbox cannot be persisted', async () => {
      await pool.query(
        "ALTER TABLE legal_hold_projection_outbox ADD CONSTRAINT synthetic_failure CHECK(operation_id<>'op-a')"
      );
      await expect(createAccountLegalHold(adapter, input)).rejects.toMatchObject({ code: '23514' });
      expect(await counts()).toEqual({ holds: 0, events: 0, outbox: 0 });
      expect(
        (
          await pool.query(
            'SELECT projection_state,projection_generation::integer AS generation FROM account_legal_hold_states'
          )
        ).rows[0]
      ).toEqual({ projection_state: 'inactive', generation: 1 });
    });

    it('preserves deletion side effects and never moves a deleted account backward', async () => {
      const transition = (state: 'deleting' | 'deleted') =>
        transitionCanonicalAccountDeletion(adapter, {
          tenantId: 'tenant-a',
          accountId: 'account-a',
          state,
          now: 3000,
        });
      expect(await transition('deleting')).toBe(true);
      expect((await createAccountLegalHold(adapter, input))[0].rowsAffected).toBe(0);
      expect(await transition('deleted')).toBe(true);
      expect(await transition('deleted')).toBe(true);
      expect(await transition('deleting')).toBe(false);
      expect((await pool.query('SELECT event_type FROM account_webhook_outbox')).rows).toEqual([
        { event_type: 'account.deleted' },
      ]);
      expect(
        (await pool.query('SELECT revision::integer AS revision FROM service_group_inputs')).rows
      ).toEqual([{ revision: 2 }]);
    });

    it('denies runtime history mutation including deletion through its FK parent', async () => {
      await createAccountLegalHold(adapter, input);
      role = `authrim_role_${randomUUID().replaceAll('-', '')}`;
      await pool.query(`CREATE ROLE "${role}"; GRANT USAGE ON SCHEMA "${schema}","${events}" TO "${role}";
      GRANT SELECT,INSERT ON ALL TABLES IN SCHEMA "${events}" TO "${role}";
      GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      const client = await pool.connect();
      try {
        await client.query(`SET ROLE "${role}"`);
        for (const sql of [
          "UPDATE legal_hold_events SET reason_code='changed'",
          'DELETE FROM legal_hold_events',
          'TRUNCATE legal_hold_events',
          'DELETE FROM legal_holds',
          'TRUNCATE legal_holds',
          'DELETE FROM identity_accounts',
        ]) {
          await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
        }
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
      expect(await counts()).toEqual({ holds: 1, events: 1, outbox: 1 });
    });

    if (mode === 'dsql-explicit')
      it('reconciles uncertain commit through its pinned operation receipt', async () => {
        const capability = createDsqlGovernanceMutations(
          {
            query: db.query.bind(db),
            queryOne: db.queryOne.bind(db),
            execute: db.execute.bind(db),
            async retryableTransaction<T>(fn: (tx: TransactionContext) => Promise<T>) {
              await db.retryableTransaction(fn);
              throw new Error('lost reply');
            },
          },
          schema,
          events
        );
        expect((await capability.createLegalHold(input))[0].rowsAffected).toBe(0);
        expect(await counts()).toEqual({ holds: 1, events: 1, outbox: 1 });
        await expect(
          capability.createLegalHold({ ...input, reasonCode: 'changed' })
        ).rejects.toThrow('account_governance_operation_conflict');
      });
  }
);
