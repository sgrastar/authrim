import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TransactionContext } from '@authrim/ar-lib-core/db/adapter';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../import/postgres-restore-table-contract';
import { AuroraDsqlAdapter } from './adapter';
import {
  createDsqlConfigurationFixture,
  type DsqlConfigurationFixture,
} from './configuration-fixture';
import {
  createDsqlConfigurationSchemaPlan,
  dsqlConfigurationTableName,
  type DsqlConfigurationTableName,
} from './configuration-schema';
import {
  createDsqlConfigurationImportJournal,
  restoreDsqlConfigurationSlice,
  verifyDsqlConfigurationSubset,
  verifyDsqlConfigurationReferences,
  type DsqlConfigurationImportInput,
} from './configuration-import';

const databaseUrl = process.env.AUTHRIM_AWS_TEST_DATABASE_URL;

// Opt-in, local PostgreSQL only: verifies real constraints and the shared SQL/import
// contract. This is not evidence of DSQL service support, asynchronous DDL, or OCC.
(databaseUrl ? describe : describe.skip)('DSQL configuration contract on native PostgreSQL', () => {
  let pool: Pool;
  let db: AuroraDsqlAdapter;
  let schema: string;
  let fixture: DsqlConfigurationFixture;
  let input: DsqlConfigurationImportInput;
  const table = (name: DsqlConfigurationTableName) => dsqlConfigurationTableName(schema, name);

  beforeEach(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: '-c default_transaction_isolation=repeatable\\ read',
    });
    db = new AuroraDsqlAdapter(
      {
        hostname: `${'a'.repeat(26)}.dsql.ap-northeast-1.on.aws`,
        region: 'ap-northeast-1',
        user: 'admin',
      },
      { poolFactory: () => pool }
    );
    schema = `authrim_dsql_configuration_${randomUUID().replaceAll('-', '')}`;
    const plan = createDsqlConfigurationSchemaPlan(schema);
    await db.execute(`CREATE SCHEMA "${schema}"`);
    for (const definition of plan.tables) await db.execute(definition.sql);
    for (const index of plan.indexes) {
      // Translation is test-only. Production must retain ASYNC and wait for catalog readiness.
      await db.execute(index.sql.replace(' INDEX ASYNC ', ' INDEX '));
    }
    await createDsqlConfigurationImportJournal(db, schema);
    fixture = await createDsqlConfigurationFixture({ spCount: 3 });
    input = {
      db,
      schema,
      backup: fixture.backup,
      tenantId: fixture.tenantId,
      trustedReceiptSha256: fixture.trustedReceiptDigest,
      maxRowsPerChunk: 2,
    };
  });

  afterEach(async () => {
    await fixture?.close();
    // Only the random schema created by this test is removed. No source/serving schema is touched.
    if (schema && pool) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db?.close();
  });

  async function restore() {
    for (let step = 0; step < 20; step++) {
      const progress = await restoreDsqlConfigurationSlice(input);
      if (progress.status !== 'loading') return progress;
    }
    throw new Error('test_restore_did_not_finish');
  }

  async function clone(
    name: DsqlConfigurationTableName,
    id: string,
    fields: Record<string, unknown>
  ) {
    const spec = POSTGRES_RESTORE_TABLE_CONTRACTS.find((item) => item.table === name);
    if (!spec) throw new Error('test_contract_missing');
    const prior = await db.queryOne<Record<string, unknown>>(
      `SELECT * FROM ${table(name)} WHERE id=$1`,
      [id]
    );
    if (!prior) throw new Error('test_row_missing');
    const row = { ...prior, ...fields };
    return db.execute(
      `INSERT INTO ${table(name)} (${spec.columns.map((column) => `"${column}"`).join(',')}) VALUES (${spec.columns.map((_, index) => `$${index + 1}`).join(',')})`,
      spec.columns.map((column) => row[column])
    );
  }

  it('resumes the verified encrypted backup and reconciles lost COMMIT replies without duplicating rows', async () => {
    expect(await restoreDsqlConfigurationSlice(input)).toMatchObject({
      status: 'loading',
      datasetIndex: 0,
      rowOffset: 2,
      revision: 1,
    });
    await input.backup.close();
    input.backup = await fixture.reopen();
    let repliesLost = 0;
    input.db = {
      query: (sql, values, options) => db.query(sql, values, options),
      queryOne: (sql, values, options) => db.queryOne(sql, values, options),
      execute: (sql, values) => db.execute(sql, values),
      async retryableTransaction<T>(callback: (tx: TransactionContext) => Promise<T>): Promise<T> {
        const result = await db.retryableTransaction(callback);
        if (repliesLost === 0) {
          repliesLost++;
          throw new Error('synthetic_reply_lost');
        }
        return result;
      },
    };
    expect(await restore()).toMatchObject({ status: 'sealed', datasetIndex: 4 });
    const receipt = await verifyDsqlConfigurationSubset(input);
    expect(receipt).toMatchObject({
      scope: 'four-table-saml-configuration-evaluation',
      fullRuntimeReady: false,
    });
    expect(receipt.tables.map((item) => [item.datasetId, item.rowCount])).toEqual([
      ['core.identity_providers', 3],
      ['core.flows', 3],
      ['core.flow_versions', 3],
      ['core.flow_assignments', 4],
    ]);
    expect(receipt.omittedDatasets).toContain('core.users_core');
    expect(receipt.omittedDatasets).not.toContain('core.flows');
    expect(await verifyDsqlConfigurationSubset(input)).toEqual(receipt);
    expect(repliesLost).toBe(1);
    const row = await db.queryOne<{ runtime_snapshot_json: string }>(
      `SELECT runtime_snapshot_json FROM ${table('flow_versions')} WHERE id=$1`,
      ['synthetic-version-000000']
    );
    expect(row?.runtime_snapshot_json).toContain('9007199254740993');
    expect(row?.runtime_snapshot_json).toContain('1e-3');
  });

  it('rejects an untrusted tenant or changed resume receipt before making further writes', async () => {
    await expect(
      restoreDsqlConfigurationSlice({ ...input, tenantId: 'other-tenant' })
    ).rejects.toThrow('aurora_dsql_configuration_import_invalid');
    expect(
      await db.queryOne(`SELECT 1 FROM "${schema}"."authrim_configuration_import_operation"`)
    ).toBeNull();
    await restoreDsqlConfigurationSlice(input);
    await expect(
      restoreDsqlConfigurationSlice({ ...input, trustedReceiptSha256: 'f'.repeat(64) })
    ).rejects.toThrow('aurora_dsql_configuration_import_invalid');
    expect(
      await db.queryOne(`SELECT COUNT(*)::int AS count FROM ${table('identity_providers')}`)
    ).toEqual({ count: 2 });
  });

  it('compares JSON text exactly, including integers beyond JavaScript precision', async () => {
    await restore();
    await db.execute(
      `UPDATE ${table('flow_versions')} SET runtime_snapshot_json=replace(runtime_snapshot_json,'9007199254740993','9007199254740992')`
    );
    await expect(verifyDsqlConfigurationSubset(input)).rejects.toThrow(
      'aurora_dsql_configuration_verification_mismatch'
    );
  });

  it.each([
    [
      'wrong published parent',
      `UPDATE flows SET published_version_id='synthetic-version-000001' WHERE id='synthetic-flow-000000'`,
    ],
    [
      'missing published version',
      `UPDATE flows SET published_version_id=NULL WHERE id='synthetic-flow-000000'`,
    ],
    [
      'cross-tenant version',
      `UPDATE flow_versions SET tenant_id='other-tenant' WHERE id='synthetic-version-000000'`,
    ],
    [
      'cross-tenant assignment',
      `UPDATE flow_assignments SET tenant_id='other-tenant' WHERE id='synthetic-assignment-000000'`,
    ],
    [
      'missing SP',
      `UPDATE flow_assignments SET target_id='https://missing.example.test' WHERE id='synthetic-assignment-000000'`,
    ],
    [
      'wrong provider type',
      `UPDATE identity_providers SET provider_type='saml_idp' WHERE id='synthetic-sp-000000'`,
    ],
    [
      'unsupported inventory',
      `UPDATE flow_assignments SET target_type='oidc_client' WHERE id='synthetic-assignment-000000'`,
    ],
    [
      'invalid SP JSON',
      `UPDATE identity_providers SET config_json='not json' WHERE id='synthetic-sp-000000'`,
    ],
    [
      'invalid Flow JSON',
      `UPDATE flow_versions SET runtime_snapshot_json='not json' WHERE id='synthetic-version-000000'`,
    ],
  ])('rejects %s during reference verification', async (_name, statement) => {
    await restore();
    const sql = statement.replace(
      /UPDATE ([a-z_]+)/u,
      (_, name: DsqlConfigurationTableName) => `UPDATE ${table(name)}`
    );
    await db.execute(sql);
    await expect(verifyDsqlConfigurationReferences(db, schema, fixture.tenantId)).rejects.toThrow(
      'aurora_dsql_configuration_verification_mismatch'
    );
  });

  it('retains native FK and target-shape checks rather than removing unsupported protections', async () => {
    await restore();
    for (const name of ['flow_versions', 'flow_assignments'] as const) {
      await expect(
        db.execute(`UPDATE ${table(name)} SET flow_id='missing' WHERE id LIKE '%000000'`)
      ).rejects.toMatchObject({ code: '23503' });
    }
    await expect(
      db.execute(
        `UPDATE ${table('flow_assignments')} SET target_type='tenant' WHERE target_id IS NOT NULL`
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      clone('flow_versions', 'synthetic-version-000000', { id: 'duplicate-version' })
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('enforces partial uniqueness even when disabled and permits only deleted Flow slug reuse', async () => {
    await restore();
    await expect(
      clone('flows', 'synthetic-flow-000000', { id: 'duplicate-active', is_active: false })
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      clone('flows', 'synthetic-flow-000000', {
        id: 'deleted-copy',
        deleted_at: '1',
        status: 'draft',
        published_version_id: null,
      })
    ).resolves.toMatchObject({ rowsAffected: 1 });
    await expect(
      clone('flow_assignments', 'synthetic-assignment-000000', {
        id: 'duplicate-disabled',
        enabled: false,
      })
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      clone('flow_assignments', 'synthetic-assignment-000003', {
        id: 'duplicate-default',
        enabled: false,
      })
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      clone('identity_providers', 'synthetic-sp-000000', { id: 'duplicate-sp', enabled: 0 })
    ).rejects.toMatchObject({ code: '23505' });
  });
});
