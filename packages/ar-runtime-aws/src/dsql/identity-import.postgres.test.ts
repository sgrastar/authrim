import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import type { TransactionContext } from '@authrim/ar-lib-core';
import { AuroraDsqlAdapter } from './adapter';
import { createDsqlIdentityFixture, type DsqlIdentityFixture } from './identity-fixture';
import {
  createDsqlIdentityImportJournal,
  restoreDsqlIdentitySlice,
  verifyDsqlIdentitySubset,
  type DsqlIdentityImportDatabase,
  type DsqlIdentityImportInput,
} from './identity-import';
import { createDsqlIdentitySchemaPlan } from './identity-schema';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

// This exercises native PostgreSQL constraints and the shared PG transport/import
// protocol. It is not evidence for DSQL's ASYNC indexes, OCC, or service limits.
(databaseUrl ? it : it.skip)(
  'imports encrypted native identity rows with resume and durable recovery against local PostgreSQL',
  async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      options: '-c default_transaction_isolation=repeatable\\ read',
      max: 4,
    });
    const db = new AuroraDsqlAdapter(
      {
        hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
        region: 'ap-northeast-1',
        user: 'admin',
      },
      { poolFactory: () => pool }
    );
    const schema = `authrim_dsql_identity_${randomUUID().replaceAll('-', '')}`;
    const plan = createDsqlIdentitySchemaPlan(schema);
    const qualified = (name: string) => `"${schema}"."${name}"`;
    const createdTables: string[] = [];
    let schemaCreated = false;
    let fixture: DsqlIdentityFixture | undefined;
    let loseNextCommitReply = false;
    let lostReplies = 0;
    const transport: DsqlIdentityImportDatabase = {
      query: (sql, params, options) => db.query(sql, params, options),
      queryOne: (sql, params, options) => db.queryOne(sql, params, options),
      execute: (sql, params) => db.execute(sql, params),
      async retryableTransaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T> {
        const result = await db.retryableTransaction(callback);
        if (loseNextCommitReply) {
          loseNextCommitReply = false;
          lostReplies++;
          throw new Error('synthetic_commit_reply_lost_after_real_commit');
        }
        return result;
      },
    };
    try {
      expect((await db.execute(`CREATE SCHEMA "${schema}"`)).success).toBe(true);
      schemaCreated = true;
      for (const table of plan.tables) {
        expect((await db.execute(table.sql)).success).toBe(true);
        createdTables.push(table.name);
      }
      for (const index of plan.indexes) {
        // Test-only translation. Real DSQL initialization must use ASYNC and poll.
        expect((await db.execute(index.sql.replace(' INDEX ASYNC ', ' INDEX '))).success).toBe(
          true
        );
      }
      await createDsqlIdentityImportJournal(db, schema, {
        onProgress: (event) => {
          if (event.status === 'created') createdTables.push(event.name);
        },
      });
      fixture = await createDsqlIdentityFixture({ userCount: 5 });
      const tenantId = fixture.tenantId;
      const trustedReceiptSha256 = fixture.trustedReceiptDigest;
      let backup = fixture.backup;
      const input = (): DsqlIdentityImportInput => ({
        db: transport,
        schema,
        backup,
        tenantId,
        trustedReceiptSha256,
        maxRowsPerChunk: 2,
      });
      expect(await restoreDsqlIdentitySlice(input())).toMatchObject({
        status: 'loading',
        datasetIndex: 0,
        rowOffset: 2,
        revision: 1,
        fullRuntimeReady: false,
      });
      await backup.close();
      backup = await fixture.reopen();
      loseNextCommitReply = true;
      expect(await restoreDsqlIdentitySlice(input())).toMatchObject({
        status: 'loading',
        datasetIndex: 0,
        rowOffset: 4,
        revision: 2,
      });
      expect(lostReplies).toBe(1);
      expect(
        await db.queryOne<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${qualified('users_core')}`
        )
      ).toEqual({ count: '4' });
      let state = await restoreDsqlIdentitySlice(input());
      for (let step = 0; state.status === 'loading' && step < 30; step++) {
        state = await restoreDsqlIdentitySlice(input());
      }
      expect(state).toMatchObject({ status: 'sealed', datasetIndex: 3, rowOffset: 0, revision: 9 });
      const receipt = await verifyDsqlIdentitySubset(input());
      expect(receipt).toMatchObject({
        status: 'native_subset_verified',
        scope: 'three-table-identity-evaluation',
        fullRuntimeReady: false,
        sourceContractFingerprint: plan.sourceContractFingerprint,
      });
      expect(receipt.tables.map(({ datasetId, rowCount }) => ({ datasetId, rowCount }))).toEqual([
        { datasetId: 'core.users_core', rowCount: 5 },
        { datasetId: 'pii.users_pii', rowCount: 5 },
        { datasetId: 'core.passkeys', rowCount: 5 },
      ]);
      const restored = new Set(plan.tables.map((table) => table.datasetId));
      expect(receipt.omittedDatasets).toEqual(
        fixture.backup.manifest.datasets
          .filter((dataset) => !restored.has(dataset.id))
          .map((dataset) => dataset.id)
          .sort()
      );
      expect(
        await db.queryOne(
          `SELECT COUNT(*)::text AS count, MAX((chunk_json::jsonb->>'rows')::integer) AS max_rows,
                SUM((chunk_json::jsonb->>'rows')::integer)::text AS total_rows
         FROM ${qualified('authrim_identity_import_chunks')}`
        )
      ).toEqual({ count: '9', max_rows: 2, total_rows: '15' });
      expect(
        await db.queryOne(
          `SELECT counter FROM ${qualified('passkeys')} WHERE id=$1 AND tenant_id=$2`,
          ['synthetic-passkey-000000', tenantId]
        )
      ).toEqual({ counter: '9007199254740993' });
      expect(
        await db.queryOne(
          `SELECT custom_attributes_json->>'purpose' AS purpose,
                  custom_attributes_json->>'ordinal' AS ordinal,
                  custom_attributes_json->>'preciseInteger' AS precise_integer,
                  custom_attributes_json->>'fraction' AS fraction,
                  custom_attributes_json->>'exponent' AS exponent
             FROM ${qualified('users_pii')} WHERE id=$1 AND tenant_id=$2`,
          ['synthetic-user-000000', tenantId]
        )
      ).toEqual({
        purpose: 'DSQL適合試験',
        ordinal: '0',
        precise_integer: '9007199254740993',
        fraction: '0.125',
        exponent: '0.001',
      });

      // Both integers round to the same JavaScript Number. The database-side
      // JSONB comparison must detect this change without JSON.parse rounding.
      await db.execute(
        `UPDATE ${qualified('users_pii')}
            SET custom_attributes_json=jsonb_set(custom_attributes_json,'{preciseInteger}',$1::jsonb)
          WHERE tenant_id=$2 AND id=$3`,
        ['9007199254740992', tenantId, 'synthetic-user-000000']
      );
      await expect(verifyDsqlIdentitySubset(input())).rejects.toThrow(
        'aurora_dsql_identity_verification_mismatch'
      );
      await db.execute(
        `UPDATE ${qualified('users_pii')}
            SET custom_attributes_json=jsonb_set(custom_attributes_json,'{preciseInteger}',$1::jsonb)
          WHERE tenant_id=$2 AND id=$3`,
        ['9007199254740993', tenantId, 'synthetic-user-000000']
      );
      expect(await verifyDsqlIdentitySubset(input())).toEqual(receipt);

      await expect(
        db.transaction((tx) =>
          tx.execute(
            `UPDATE ${qualified('users_core')} SET status=$1 WHERE tenant_id=$2 AND id=$3`,
            ['invalid-status', tenantId, 'synthetic-user-000000']
          )
        )
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        db.transaction((tx) =>
          tx.execute(
            `INSERT INTO ${qualified('passkeys')}
           (id,tenant_id,user_id,credential_id,public_key,counter,created_at)
         SELECT $1,tenant_id,user_id,credential_id,public_key,counter,created_at
           FROM ${qualified('passkeys')} WHERE tenant_id=$2 AND id=$3`,
            ['synthetic-duplicate', tenantId, 'synthetic-passkey-000000']
          )
        )
      ).rejects.toMatchObject({ code: '23505' });
      expect(await verifyDsqlIdentitySubset(input())).toEqual(receipt);
      await db.execute(
        `UPDATE ${qualified('users_pii')} SET name=$1 WHERE tenant_id=$2 AND id=$3`,
        ['synthetic-tampered', tenantId, 'synthetic-user-000000']
      );
      await expect(verifyDsqlIdentitySubset(input())).rejects.toThrow(
        'aurora_dsql_identity_verification_mismatch'
      );
    } finally {
      try {
        await fixture?.close();
      } finally {
        try {
          // Drop only tables whose CREATE returned success. Indexes belong to
          // those tables. No broad CASCADE or database/container cleanup.
          for (const name of createdTables.reverse())
            await db.execute(`DROP TABLE ${qualified(name)}`);
          if (schemaCreated) await db.execute(`DROP SCHEMA "${schema}"`);
          expect(
            await db.queryOne('SELECT nspname FROM pg_namespace WHERE nspname=$1', [schema])
          ).toBeNull();
        } finally {
          await db.close();
        }
      }
    }
  },
  60_000
);
