import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  listMigrationSourceFiles,
  readMigrationSource,
} from '../../../../test/helpers/migration-source.mjs';
import {
  applyTenantMigrationBackfillPage,
  pruneTargetInstalledConsentStatements,
  readTenantMigrationBackfillPage,
  type TenantMigrationTransferExecutor,
} from '../tenant-placement-migration-transfer';
import {
  orderTenantMigrationTables,
  type TenantMigrationTableInventory,
} from '../tenant-placement-migration-inventory';

const CORE = new URL('../../../../migrations/core/d1/', import.meta.url);
const TABLES = [
  'consent_statements',
  'consent_statement_versions',
  'consent_statement_localizations',
  'statement_consent_projection_jobs',
];

/** A fresh core database: the 0.5.0 baseline and every later delta (core migration 013 too). */
function freshCore(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const files = listMigrationSourceFiles(CORE);
  const number = (name: string) => Number(name.split('_')[0]);
  const start = files.findIndex(
    (name, index) => index > 0 && number(name) < number(files[index - 1])
  );
  const later = start < 0 ? [] : files.slice(start).filter((name) => number(name) > 2);
  for (const file of ['001_0_5_0_core_baseline.sql', ...later]) {
    db.exec(
      readMigrationSource(CORE, file)
        .replaceAll('__AUTHRIM_NOW_PRECISE_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_MILLISECONDS__', '(unixepoch() * 1000)')
        .replaceAll('__AUTHRIM_NOW_EPOCH_SECONDS__', 'unixepoch()')
    );
  }
  return db;
}

type Value = string | number | null;

function executor(databases: Record<string, DatabaseSync>): TenantMigrationTransferExecutor {
  const run = (id: string, sql: string, params: unknown[] = []) => {
    const statement = databases[id].prepare(sql);
    const values = params as Value[];
    return /^\s*SELECT/iu.test(sql)
      ? { success: true, results: statement.all(...values) }
      : (statement.run(...values), { success: true, results: [] });
  };
  return {
    async queryD1(id, sql, params) {
      return [run(id, sql, params)] as never;
    },
    async queryD1Batch(id, batch) {
      databases[id].exec('BEGIN');
      try {
        const results = batch.map(({ sql, params }) => run(id, sql, params));
        databases[id].exec('COMMIT');
        return results;
      } catch (error) {
        databases[id].exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function inventory(db: DatabaseSync): TenantMigrationTableInventory[] {
  return TABLES.map((table) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
      pk: number;
    }[];
    const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
      from: string;
      table: string;
      to: string;
    }[];
    return {
      table,
      columns: columns.map((column) => ({ name: column.name, primaryKeyPosition: column.pk })),
      primaryKey: columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      ownership: { kind: 'tenant_column', column: 'tenant_id' },
      disposition: 'migrate',
      foreignKeys: keys.map((key) => ({
        column: key.from,
        parentTable: key.table,
        parentColumn: key.to,
      })),
    };
  });
}

/** Copy the tenant's consent tables as the reconciler's backfill does, then read both sides. */
async function migrate(source: DatabaseSync, target: DatabaseSync, retryFirstPage = false) {
  const transfer = executor({ source, target });
  const tables = orderTenantMigrationTables(inventory(source));
  const pages: Record<string, unknown[][]> = { source: [], target: [] };
  for (const table of tables) {
    let cursor: Record<string, unknown> | null = null;
    for (;;) {
      const page = await readTenantMigrationBackfillPage({
        executor: transfer,
        sourceDatabaseId: 'source',
        table,
        tenantId: 'default',
        tenantKey: 'default',
        cursor,
      });
      for (let attempt = 0; attempt < (retryFirstPage ? 2 : 1); attempt += 1) {
        if (table.table === 'consent_statements' && cursor === null) {
          await pruneTargetInstalledConsentStatements({
            executor: transfer,
            targetDatabaseId: 'target',
            operationId: 'operation-1',
            tenantId: 'default',
          });
        }
        await applyTenantMigrationBackfillPage({
          executor: transfer,
          targetDatabaseId: 'target',
          table,
          tenantId: 'default',
          tenantKey: 'default',
          rows: page.rows,
        });
      }
      if (page.done) break;
      cursor = page.nextCursor;
    }
  }
  for (const side of ['source', 'target'] as const) {
    for (const table of tables) {
      const page = await readTenantMigrationBackfillPage({
        executor: transfer,
        sourceDatabaseId: side,
        table,
        tenantId: 'default',
        tenantKey: 'default',
        cursor: null,
      });
      pages[side].push(page.rows);
    }
  }
  return pages;
}

describe('moving the baseline tenant to a database of its own', () => {
  it('matches a source that holds its own terms of service under the default key', async () => {
    const source = freshCore();
    // The source tenant had its own terms of service before migration 013 (which then gave it
    // only the privacy policy).
    source.exec(`
      DELETE FROM statement_consent_projection_jobs WHERE statement_id = 'cst_default_terms:default';
      DELETE FROM consent_statement_localizations WHERE version_id = 'csv_default_terms:default';
      DELETE FROM consent_statement_versions WHERE id = 'csv_default_terms:default';
      DELETE FROM consent_statements WHERE id = 'cst_default_terms:default';
      INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
        VALUES ('own-terms', 'default', 'terms-of-service', 'terms_of_service', 1, 1);`);
    const pages = await migrate(source, freshCore());
    expect(pages.target).toEqual(pages.source);
  });

  it('matches a source that published a later version of a default statement', async () => {
    const source = freshCore();
    source.exec(`
      UPDATE consent_statement_versions
         SET is_current = 0, current_statement_guard = NULL, status = 'archived', updated_at = 2
       WHERE id = 'csv_default_privacy:default';
      INSERT INTO consent_statement_versions
        (id, tenant_id, statement_id, version, content_type, effective_at, is_current,
         current_statement_guard, status, created_at, updated_at)
      VALUES ('a-later', 'default', 'cst_default_privacy:default', '20261201', 'url', 2, 1,
              'cst_default_privacy:default', 'active', 2, 2);`);
    const pages = await migrate(source, freshCore(), true);
    expect(pages.target).toEqual(pages.source);
  });

  it('matches a source whose default statements were deleted', async () => {
    const source = freshCore();
    for (const table of [...TABLES].reverse()) source.exec(`DELETE FROM ${table}`);
    const pages = await migrate(source, freshCore());
    expect(pages.target).toEqual(pages.source);
    expect(pages.target.flat()).toEqual([]);
  });

  it('matches a source that gave a default statement another key and reused its key', async () => {
    const source = freshCore();
    source.exec(`
      UPDATE consent_statements SET slug = 'old-terms' WHERE id = 'cst_default_terms:default';
      INSERT INTO consent_statements (id, tenant_id, slug, category, created_at, updated_at)
        VALUES ('a-new-terms', 'default', 'terms-of-service', 'custom', 1, 1);`);
    const pages = await migrate(source, freshCore());
    expect(pages.target).toEqual(pages.source);
  });

  it('removes nothing when a run resumes after the copy went on', async () => {
    const source = freshCore();
    const target = freshCore();
    const pages = await migrate(source, target);
    // A run that stopped before its removal resumes once the copy is done.
    await pruneTargetInstalledConsentStatements({
      executor: executor({ target }),
      targetDatabaseId: 'target',
      operationId: 'operation-1',
      tenantId: 'default',
    });
    const after = await migrate(source, target);
    expect(after.target).toEqual(pages.target);
    expect(after.target).toEqual(after.source);
  });
});
