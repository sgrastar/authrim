import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderPortableMigrationSql } from '../../../../ar-lib-core/src/migrations/sql-portability';
import type { VerifiedTenantBackupV2 } from '../backup-reader';
import { restoreVerifiedPostgresFamily } from '../postgres-restore';
import { POSTGRES_RESTORE_TABLE_CONTRACTS } from '../postgres-restore-table-contract';
import { POSTGRES_RESTORE_EXTENSION_CONTRACTS } from '../postgres-restore-extension-contract';
import { expectPostgresRestoreReceiptTables } from './postgres-restore-receipt-expectations';

// Only the receipt projection is under test here; native PG constraints, seeds and
// trigger metadata remain covered by postgres-restore.postgres.test.ts.
vi.mock('../postgres-restore-reference-seeds', () => ({
  preparePostgresReferenceSeeds: vi.fn(),
}));
vi.mock('../postgres-restore-triggers', () => ({
  suspendSnapshotProjectionTriggers: vi.fn(async () => []),
  restoreSnapshotProjectionTriggers: vi.fn(),
}));
vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async end() {}
    async query(sql: string) {
      if (
        !/^(BEGIN|CREATE TABLE|SELECT|INSERT INTO authrim_aws_import_staging|INSERT INTO statement_consent_(guards|projection_jobs)|COMMIT|ROLLBACK)/u.test(
          sql
        )
      )
        throw new Error('unexpected_receipt_test_query');
      return { rows: [], rowCount: 0 };
    }
  },
}));

interface LocalSqlite {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    setReadBigInts(enabled: boolean): void;
    all(...values: (string | bigint | null)[]): Array<Record<string, string | bigint | null>>;
  };
}

const sqliteModule = 'node:sqlite';
const { DatabaseSync } = (await import(sqliteModule)) as {
  DatabaseSync: new (path: string) => LocalSqlite;
};

// Run without PostgreSQL so D1 column drift is caught by the default test suite.
describe.each(['core', 'pii'] as const)(
  '%s D1-to-PostgreSQL restore schema contracts',
  (family) => {
    let db: LocalSqlite;

    beforeAll(async () => {
      db = new DatabaseSync(':memory:');
      const migrations = new URL(`../../../../../migrations/${family}/d1/`, import.meta.url);
      for (const file of [`001_0_5_0_${family}_baseline.sql`]) {
        db.exec(
          renderPortableMigrationSql(await readFile(new URL(file, migrations), 'utf8'), 'sqlite')
        );
      }
    });

    afterAll(() => db?.close());

    it.each(
      family === 'core'
        ? ['all', 'base', 'selected', 'source-authority', 'without-login-ui']
        : ['all', 'base', 'selected']
    )('includes exactly the restored contracts in the staging receipt: %s', async (mode) => {
      const base = POSTGRES_RESTORE_TABLE_CONTRACTS.filter((spec) => spec.family === family);
      const extensions = POSTGRES_RESTORE_EXTENSION_CONTRACTS.filter(
        (spec) => spec.family === family
      );
      const source = [
        ...base.filter(
          (spec) =>
            mode !== 'without-login-ui' ||
            !['core.oauth_clients', 'core.web_origin_registry'].includes(spec.datasetId)
        ),
        ...extensions.filter(
          (spec) =>
            mode === 'all' ||
            (mode === 'selected' &&
              ['core.guest_deletion_audit_outbox', 'pii.guest_upgrade_operations'].includes(
                spec.datasetId
              )) ||
            (mode === 'source-authority' &&
              ['core.statement_consent_guards', 'core.statement_consent_admissions'].includes(
                spec.datasetId
              ))
        ),
      ];
      const tenantId = 'receipt-tenant';
      for (const spec of source)
        expect(
          db.prepare(`SELECT * FROM "${spec.table}" WHERE "${spec.tenantColumn}"=?`).all(tenantId)
        ).toEqual([]);
      const backup: VerifiedTenantBackupV2 = {
        manifest: {
          formatVersion: 1,
          bundleId: 'a'.repeat(32),
          snapshotId: 'receipt-snapshot',
          inventoryDigestSha256: 'b'.repeat(64),
          source: { tenantId, issuer: 'https://idp.example.test', productVersion: '0.4.2' },
          boundaryUnixMs: 1_780_000_000_000,
          selection: {
            settings: true,
            users: true,
            admin: false,
            artifacts: false,
            logs: { audit: false, other: false, sensitive: false, period: 'all' },
          },
          datasets: source.map((spec) => ({
            id: spec.datasetId,
            module: 'users',
            kind: 'users',
            store: 'database',
            schemaVersion: 1,
            disposition: 'include',
          })),
        },
        dataset(id) {
          if (!source.some((spec) => spec.datasetId === id))
            throw new Error('unknown_receipt_test_dataset');
          return {
            id,
            rows: 0,
            bytes: 0,
            async readNextRow() {
              return null;
            },
          };
        },
        async close() {},
      };
      const receipt = await restoreVerifiedPostgresFamily({
        backup,
        family,
        tenantId,
        targetId: '11111111-1111-4111-8111-111111111111',
        connectionString: 'unused',
      });
      expectPostgresRestoreReceiptTables(
        receipt,
        source.map((spec) => spec.datasetId)
      );
      expect(receipt.projectionVersion).toBe(mode === 'all' || mode === 'selected' ? 2 : undefined);
    });

    it.each(
      [...POSTGRES_RESTORE_TABLE_CONTRACTS, ...POSTGRES_RESTORE_EXTENSION_CONTRACTS].filter(
        (spec) => spec.family === family
      )
    )('$datasetId preserves every column, integer column and ordered primary key', (spec) => {
      const info = db.prepare(`PRAGMA table_info("${spec.table}")`);
      info.setReadBigInts(true);
      const columns = info.all();

      expect(columns.map((column) => String(column.name)).sort(), spec.datasetId).toEqual(
        [...spec.columns].sort()
      );
      expect(
        columns
          .filter((column) => /INT/iu.test(String(column.type)))
          .map((column) => String(column.name))
          .sort(),
        spec.datasetId
      ).toEqual([...spec.sqliteIntegerColumns].sort());
      expect(
        columns
          .filter((column) => typeof column.pk === 'bigint' && column.pk > 0n)
          .sort((left, right) => Number(left.pk) - Number(right.pk))
          .map((column) => String(column.name)),
        spec.datasetId
      ).toEqual(spec.primaryKey);
    });
  }
);
