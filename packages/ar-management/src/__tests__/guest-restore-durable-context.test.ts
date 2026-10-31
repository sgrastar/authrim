import { readRenderedMigrationSql } from '../../../../test/helpers/migration-source.mjs';

import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLiteDatabase, type SQLInputValue } from './test-sqlite';
import type { DatabaseAdapter, Env } from '@authrim/ar-lib-core';
import { TenantBackupOperationStore } from '@authrim/ar-lib-core/services/tenant-portability/operation-store';
import { DatabaseTenantBackupRestorePlanInventory } from '@authrim/ar-lib-core/services/tenant-portability/restore-plan-inventory';
import { TenantBackupExecutionInventory } from '@authrim/ar-lib-core/services/tenant-portability/execution-inventory';
import { persistInitializedSqliteRestoreTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-plan';
import {
  persistSqliteRestoreSequence,
  runSqliteRestoreSequenceStep,
} from '@authrim/ar-lib-core/services/tenant-portability/restore-sqlite-sequence';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import type { SqliteDatasetInspectionPolicy } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-dataset-inspector';
import type { TenantBundleManifest } from '@authrim/ar-lib-core/services/tenant-portability/bundle-manifest';
import { createProductionGuestRestoreAuthority } from '../tenant-backup-guest-authority-production';

const databases: SQLiteDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function adapter(db: SQLiteDatabase): DatabaseAdapter {
  const result: DatabaseAdapter = {
    query: async <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
    queryOne: async <T>(sql: string, params: unknown[] = []) =>
      (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null,
    execute: async (sql, params = []) => ({
      success: true,
      rowsAffected: Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
    }),
    batch: async (statements) => {
      db.exec('BEGIN');
      try {
        const changes = [];
        for (const statement of statements)
          changes.push(await result.execute(statement.sql, statement.params));
        db.exec('COMMIT');
        return changes;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    transaction: vi.fn(),
    getType: () => 'd1',
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'd1' }),
    close: async () => {},
  };
  return result;
}

it.each([false, true])(
  'authorizes actual slow restore and sealed verification against the durable cursor (hold policy %s)',
  async (holds) => {
    const admin = new DatabaseSync(':memory:'),
      target = new DatabaseSync(':memory:');
    databases.push(admin, target);
    for (const file of ['001_0_5_0_admin_baseline.sql'])
      admin.exec(
        readRenderedMigrationSql(
          new URL(`../../../../migrations/admin/d1/`, import.meta.url),
          `${file}`
        )
      );
    target.exec(
      readRenderedMigrationSql(
        new URL('../../../../migrations/core/d1/', import.meta.url),
        '010_tenant_backup_restore_target.sql'
      )
    );
    target.exec('CREATE TABLE owners(id TEXT PRIMARY KEY NOT NULL,tenant_id TEXT NOT NULL)');
    const primary = adapter(admin),
      physical = adapter(target),
      now = Date.now();
    const store = new TenantBackupOperationStore(primary);
    await store.create({
      id: 'import',
      tenantId: 'tenant-a',
      kind: 'import',
      idempotencyKey: 'request',
      requestDigest: 'a'.repeat(64),
      actorId: 'admin',
      now,
    });
    const operation = await store.claim('tenant-a', 'import', 'worker', now + 1);
    if (!operation) throw new Error('claim_missing');
    let durable: TenantBackupStepContext = {
      operation,
      lease: {
        tenantId: 'tenant-a',
        operationId: 'import',
        owner: 'worker',
        fencingToken: operation.fencing_token,
      },
      signal: new AbortController().signal,
    };
    const authority = createProductionGuestRestoreAuthority(
      { DB_ADMIN: primary } as unknown as Env,
      () => now + 1,
      () => durable
    );
    const inputInventory = new TenantBackupExecutionInventory(
      primary,
      durable.lease,
      () => now + 1
    );
    await inputInventory.create();
    const inputHead = await inputInventory.head();
    await inputInventory.seal(inputHead.item_count, inputHead.chain_digest);
    admin
      .prepare(
        "INSERT INTO tenant_backup_validation_sessions(id,tenant_id,operation_id,fencing_token,state,created_at) VALUES('validated','tenant-a','import',?,'sealed',?)"
      )
      .run(durable.lease.fencingToken, now);
    admin
      .prepare(
        "INSERT INTO tenant_backup_input_validations(operation_id,tenant_id,session_id,input_inventory_digest,examined_references,unresolved_provenance) VALUES('import','tenant-a','validated',?,0,0)"
      )
      .run(inputHead.chain_digest);
    admin.exec("UPDATE tenant_backup_operations SET phase='prepare_restore_plan'");
    const inventory = new DatabaseTenantBackupRestorePlanInventory(
      primary,
      durable.lease,
      () => now + 1
    );
    await inventory.create(inputHead.chain_digest);
    const resource = {
      targetId: 'target',
      resourceId: 'physical',
      provisioningId: 'provision-op',
      database: physical,
    };
    await persistInitializedSqliteRestoreTarget({
      context: durable,
      inventory,
      ordinal: 0,
      resource,
      assertProvisioningOwnership: async () => {},
    });
    const seen: { mode: string; phase: string; cursor: string | null }[] = [];
    const authorize = async (context: TenantBackupStepContext, mode: string) => {
      seen.push({ mode, phase: context.operation.phase, cursor: context.operation.cursor_json });
      await authority.authorize(context);
    };
    const policy: SqliteDatasetInspectionPolicy = {
      dataset: {
        id: 'core.owners',
        module: 'tenant-runtime',
        kind: 'users',
        store: 'database',
        schemaVersion: 1,
        disposition: 'include',
      },
      schema: {
        table: 'owners',
        columns: ['id', 'tenant_id'],
        primaryKey: ['id'],
        uniqueKeys: [],
        tenantColumn: 'tenant_id',
      },
      inspectRow: async () => [],
      restoreTransform: {
        id: 'actual-production-authority',
        statementsPerRow: 0,
        statementsPerBatch: 128,
        prepareRows: async (context, _rows, mode) => authorize(context, mode),
        assertPreparedRows: async (context) => authorize(context, 'assert'),
        transform: async (context, row, mode) => {
          await authorize(context, mode);
          return row;
        },
      },
      ...(holds
        ? {
            restoreHold: {
              id: 'source-only-rows',
              shouldHold: async () => false,
              write: async () => {},
              verify: async () => {},
            },
          }
        : {}),
    };
    const manifest: TenantBundleManifest = {
      formatVersion: 1,
      bundleId: 'b'.repeat(32),
      source: { tenantId: 'tenant-a', issuer: 'https://tenant.example', productVersion: '0.4.2' },
      selection: {
        settings: false,
        users: true,
        admin: false,
        artifacts: false,
        logs: { audit: false, other: false, sensitive: false, period: 'all' },
      },
      snapshotId: 's',
      boundaryUnixMs: 1,
      inventoryDigestSha256: 'c'.repeat(64),
      datasets: [policy.dataset],
    };
    // More than the combined path's 500-row cap guarantees the real inner-cursor fallback.
    const rows = Array.from({ length: 501 }, (_, i) =>
      JSON.stringify({ id: ['text', `owner-${i}`], tenant_id: ['text', 'tenant-a'] })
    );
    await persistSqliteRestoreSequence(inventory, 1, [
      {
        targetId: 'target',
        ordinal: 0,
        policy,
        manifest,
        recordCount: rows.length,
        byteCount: rows.reduce((total, row) => total + new TextEncoder().encode(row).length, 0),
      },
    ]);
    const head = await inventory.headForLease(durable.lease);
    await inventory.seal(head.item_count, head.chain_digest);
    let phase = 'start_sqlite_restore_sequence',
      cursor: string | null = JSON.stringify({
        version: 1,
        sequenceOrdinal: 1,
        jobIndex: 0,
        datasetCursor: null,
        completedRows: [],
        emptyPrepared: false,
      });
    const run = async () => {
      admin
        .prepare(
          'UPDATE tenant_backup_operations SET phase=?,cursor_json=?,revision=revision+1 WHERE id=?'
        )
        .run(phase, cursor, 'import');
      const current = await store.get('tenant-a', 'import');
      if (!current) throw new Error('operation_missing');
      durable = { ...durable, operation: current };
      return runSqliteRestoreSequenceStep(durable, {
        inventory,
        now: () => now + 1,
        sequenceOrdinal: 1,
        resolve: async () => resource,
        assertValidatedUnpublishedPlan: async (digest) => expect(digest).toBe(head.chain_digest),
        loadValidatedDataset: async () => ({
          policy,
          manifest,
          readNextValidatedRow: async ({ sourceCursor }) => {
            const index = sourceCursor === null ? 0 : Number(sourceCursor);
            return index < rows.length
              ? { rowJson: rows[index], nextCursor: String(index + 1) }
              : null;
          },
        }),
      });
    };
    for (let step = 0; step < 40; step++) {
      const result = await run();
      phase = result.phase;
      cursor = result.cursor;
      if (phase === 'restore_other_stores') {
        phase = 'verify_restore_targets';
        continue;
      }
      if (phase === 'verify_other_restore_stores') break;
    }
    expect(phase).toBe('verify_other_restore_stores');
    expect(target.prepare('SELECT count(*) AS n FROM owners').get()).toEqual({ n: 501 });
    expect(
      seen.some((row) => row.mode === 'write' && row.cursor !== durable.operation.cursor_json)
    ).toBe(true);
    expect(seen.some((row) => row.mode === 'verify' && row.phase === 'verify_sqlite_dataset')).toBe(
      true
    );
    // Original durable revision/phase/cursor and primary lease are still mandatory.
    admin.exec('UPDATE tenant_backup_operations SET revision=revision+1');
    await expect(
      authority.authorize({
        ...durable,
        operation: { ...durable.operation, phase: 'verify_sqlite_dataset', cursor_json: '{}' },
      })
    ).rejects.toThrow('authority_unavailable');
  }
);
