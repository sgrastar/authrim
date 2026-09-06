import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';
import type { MigrationReleaseArtifactPlan } from '../core/migration-release-publication.js';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';
import {
  beginReleaseRolloutVerification,
  buildReleaseRolloutHandoffPlan,
  completeReleaseRolloutHandoff,
  createReleaseRolloutHandoff,
  getActiveReleaseRolloutHandoffStatus,
  getReleaseRolloutHandoffStatus,
  waitForReleaseRolloutAwaitingSetup,
} from '../core/release-rollout-handoff.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIGEST = 'a'.repeat(64);
const RELEASE_ID = '0.5.0';
const OBJECT_KEY = `releases/${RELEASE_ID}/${DIGEST}/manifest.json`;

function values(params: readonly unknown[] | undefined): SqliteValue[] {
  return (params ?? []).map((value) => {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value === null ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new Error('unsupported_test_sqlite_value');
  });
}

function sqliteBatch(database: DatabaseSync) {
  return async (
    _databaseId: string,
    statements: readonly D1BatchStatement[]
  ): Promise<D1BatchExecutionResult[]> => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        const prepared = database.prepare(statement.sql);
        const params = values(statement.params);
        if (/^\s*(?:SELECT|PRAGMA|EXPLAIN)\b/iu.test(statement.sql)) {
          return { success: true as const, results: prepared.all(...params) };
        }
        const result = prepared.run(...params);
        return { success: true as const, results: [], meta: { changes: Number(result.changes) } };
      });
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
}

function fixture(): {
  manifest: ReleaseMigrationManifest;
  artifact: MigrationReleaseArtifactPlan;
} {
  const manifest: ReleaseMigrationManifest = {
    formatVersion: 2,
    productVersion: RELEASE_ID,
    rollout: {
      databaseExecution: 'setup_then_control',
      workerActivation: 'after_required_databases',
      adminMutationMode: 'read_only',
    },
    streams: [
      {
        id: 'core-d1',
        schemaFamily: 'core',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['core', 'tenant_core'],
        files: [{ path: '001.sql', checksum: 'b'.repeat(64) }],
      },
      {
        id: 'pii-d1',
        schemaFamily: 'pii',
        dialect: 'sqlite',
        targetKind: 'cloudflare-d1',
        logicalRoles: ['pii', 'tenant_pii'],
        files: [{ path: '001.sql', checksum: 'c'.repeat(64) }],
      },
    ],
  };
  return {
    manifest,
    artifact: {
      releaseId: RELEASE_ID,
      manifestDigest: DIGEST,
      manifestObjectKey: OBJECT_KEY,
      streamIds: ['core-d1', 'pii-d1'],
      objects: [],
    },
  };
}

describe('release rollout handoff', () => {
  let database: DatabaseSync;
  let executeBatch: ReturnType<typeof sqliteBatch>;

  beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    database.exec(`
      INSERT INTO control_environments (
        environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
      ) VALUES ('env-test', 'test', 'urn:authrim:control:env-test', 'active', 1, 1);
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, completed_at, updated_at
      ) VALUES (
        'op-release', 'env-test', 'register_migration_release', 'release:${RELEASE_ID}',
        'succeeded', 'setup', 1, 1, 1, 1
      );
      INSERT INTO control_migration_release_catalog (
        environment_id, stream_id, release_id, manifest_digest, manifest_r2_object_key,
        state, active_stream_key, registered_by_operation_id, registered_at, activated_at
      ) VALUES
        ('env-test', 'core-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}',
         'active', 'active', 'op-release', 1, 1),
        ('env-test', 'pii-d1', '${RELEASE_ID}', '${DIGEST}', '${OBJECT_KEY}',
         'active', 'active', 'op-release', 1, 1);
    `);
    executeBatch = sqliteBatch(database);
  });

  afterEach(() => database.close());

  it('creates one immutable idempotent handoff with all managed release pins', async () => {
    const { manifest, artifact } = fixture();
    const plan = buildReleaseRolloutHandoffPlan({
      environmentId: 'env-test',
      sourceVersion: '0.4.0',
      targetVersion: RELEASE_ID,
      artifact,
      manifest,
      managedStreamIds: ['pii-d1', 'core-d1'],
      actorId: 'setup:update',
      now: 10,
    });
    expect(plan.streamIds).toEqual(['core-d1', 'pii-d1']);
    expect(plan.operationId).toMatch(/^op_release_rollout_[a-f0-9]{32}$/u);

    const create = () =>
      createReleaseRolloutHandoff({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        sourceVersion: '0.4.0',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1', 'pii-d1'],
        actorId: 'setup:update',
        now: 10,
        executeBatch,
      });
    await expect(create()).resolves.toMatchObject({
      operationId: plan.operationId,
      phase: 'requested',
      sourceVersion: '0.4.0',
      targetVersion: RELEASE_ID,
    });
    await expect(create()).resolves.toMatchObject({ operationId: plan.operationId });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_operation_release_pins`).get()
    ).toEqual({ count: 2 });
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_release_migration_rollouts`).get()
    ).toEqual({ count: 1 });
    await expect(
      getActiveReleaseRolloutHandoffStatus({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        executeBatch,
      })
    ).resolves.toMatchObject({ operationId: plan.operationId, phase: 'requested' });
  });

  it('returns no active rollout before the handoff schema exists or before a handoff is created', async () => {
    const legacyDatabase = new DatabaseSync(':memory:');
    legacyDatabase.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/d1/001_0_4_0_control_baseline.sql'),
        'utf8'
      )
    );
    await expect(
      getActiveReleaseRolloutHandoffStatus({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        executeBatch: sqliteBatch(legacyDatabase),
      })
    ).resolves.toBeNull();
    legacyDatabase.close();

    await expect(
      getActiveReleaseRolloutHandoffStatus({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        executeBatch,
      })
    ).resolves.toBeNull();
  });

  it('rolls back every handoff record when a required catalog pin is missing', async () => {
    const { manifest, artifact } = fixture();
    database.exec(
      `DELETE FROM control_migration_release_catalog
        WHERE environment_id = 'env-test' AND stream_id = 'pii-d1'`
    );

    await expect(
      createReleaseRolloutHandoff({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        sourceVersion: '0.4.0',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1', 'pii-d1'],
        actorId: 'setup:update',
        now: 10,
        executeBatch,
      })
    ).rejects.toThrow();

    for (const table of [
      'control_operations',
      'control_release_migration_rollouts',
      'control_operation_release_pins',
      'control_audit_events',
    ]) {
      const where =
        table === 'control_operations'
          ? `WHERE operation_kind = 'release_migration_rollout'`
          : table === 'control_audit_events'
            ? `WHERE event_type = 'control.release_migration.handoff_requested'`
            : '';
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get()).toEqual({
        count: 0,
      });
    }
  });

  it('rolls back the new operation when another rollout owns the active environment', async () => {
    const { manifest, artifact } = fixture();
    const existingDigest = 'd'.repeat(64);
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status,
        requested_by_type, attempt_count, created_at, updated_at
      ) VALUES (
        'existing-rollout', 'env-test', 'release_migration_rollout', 'existing-rollout',
        'running', 'setup', 1, 5, 5
      );
      INSERT INTO control_release_migration_rollouts (
        operation_id, environment_id, source_version, target_version, release_id,
        manifest_digest, manifest_r2_object_key, database_execution, worker_activation,
        admin_mutation_mode, handoff_state, active_environment_key, created_at, updated_at
      ) VALUES (
        'existing-rollout', 'env-test', '0.4.0', '0.4.1', '0.4.1', '${existingDigest}',
        'releases/0.4.1/${existingDigest}/manifest.json', 'setup_then_control',
        'after_required_databases', 'read_only', 'database_rollout', 'env-test', 5, 5
      );
    `);

    await expect(
      createReleaseRolloutHandoff({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        sourceVersion: '0.4.0',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1'],
        actorId: 'setup:update',
        now: 10,
        executeBatch,
      })
    ).rejects.toThrow();

    expect(
      database
        .prepare(
          `SELECT operation_id FROM control_operations
            WHERE operation_kind = 'release_migration_rollout' ORDER BY operation_id`
        )
        .all()
    ).toEqual([{ operation_id: 'existing-rollout' }]);
    expect(
      database.prepare(`SELECT COUNT(*) AS count FROM control_operation_release_pins`).get()
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_audit_events
            WHERE event_type = 'control.release_migration.handoff_requested'`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it('returns durable in-progress status when the observation window expires', async () => {
    const { manifest, artifact } = fixture();
    const created = await createReleaseRolloutHandoff({
      controlDatabaseId: '01234567-89ab-cdef',
      environmentId: 'env-test',
      targetVersion: RELEASE_ID,
      artifact,
      manifest,
      managedStreamIds: ['core-d1'],
      actorId: 'setup:update',
      now: 10,
      executeBatch,
    });
    let currentTime = 1_000;

    await expect(
      waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        executeBatch,
        timeoutMs: 10,
        pollIntervalMs: 10,
        clock: () => currentTime,
        sleep: async (milliseconds) => {
          currentTime += milliseconds;
        },
      })
    ).resolves.toMatchObject({ phase: 'requested', operationId: created.operationId });
  });

  it('resumes setup from awaiting_setup and clears the fence only after release verification', async () => {
    const { manifest, artifact } = fixture();
    const created = await createReleaseRolloutHandoff({
      controlDatabaseId: '01234567-89ab-cdef',
      environmentId: 'env-test',
      sourceVersion: '0.4.0',
      targetVersion: RELEASE_ID,
      artifact,
      manifest,
      managedStreamIds: ['core-d1', 'pii-d1'],
      actorId: 'setup:update',
      now: 10,
      executeBatch,
    });
    database.exec(`
      UPDATE control_operations SET status = 'running', started_at = 11, updated_at = 12
       WHERE operation_id = '${created.operationId}';
      UPDATE control_operation_steps
         SET status = 'running', started_at = 11, updated_at = 11
       WHERE operation_id = '${created.operationId}' AND step_key = 'apply_managed_migrations';
      UPDATE control_operation_steps
         SET status = 'succeeded', progress_current = 0, progress_total = 0,
             started_at = 11, completed_at = 12, updated_at = 12
       WHERE operation_id = '${created.operationId}' AND step_key = 'apply_managed_migrations';
      UPDATE control_operation_steps
         SET status = 'running', progress_current = 0, progress_total = 1,
             started_at = 12, updated_at = 12
       WHERE operation_id = '${created.operationId}' AND step_key = 'await_setup';
      UPDATE control_release_migration_rollouts
         SET handoff_state = 'awaiting_setup', target_snapshot_at = 11, updated_at = 12
       WHERE operation_id = '${created.operationId}';
    `);

    await expect(
      waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        executeBatch,
        sleep: async () => undefined,
        timeoutMs: 10,
      })
    ).resolves.toMatchObject({ phase: 'awaiting_setup' });
    await expect(
      beginReleaseRolloutVerification({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        actorId: 'setup:update',
        now: 13,
        executeBatch,
      })
    ).resolves.toMatchObject({ phase: 'verifying' });
    expect(
      database
        .prepare(
          `SELECT active_environment_key FROM control_release_migration_rollouts
            WHERE operation_id = ?`
        )
        .get(created.operationId)
    ).toEqual({ active_environment_key: 'env-test' });

    await expect(
      completeReleaseRolloutHandoff({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        actorId: 'setup:update',
        now: 14,
        executeBatch,
      })
    ).resolves.toMatchObject({ phase: 'completed' });
    await expect(
      getReleaseRolloutHandoffStatus({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        executeBatch,
      })
    ).resolves.toMatchObject({ phase: 'completed' });
    await expect(
      getActiveReleaseRolloutHandoffStatus({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        executeBatch,
      })
    ).resolves.toBeNull();
    expect(
      database
        .prepare(
          `SELECT active_environment_key FROM control_release_migration_rollouts
            WHERE operation_id = ?`
        )
        .get(created.operationId)
    ).toEqual({ active_environment_key: `completed:${created.operationId}` });
  });

  it('fails the setup wait closed when Control blocks the rollout', async () => {
    const { manifest, artifact } = fixture();
    const created = await createReleaseRolloutHandoff({
      controlDatabaseId: '01234567-89ab-cdef',
      environmentId: 'env-test',
      targetVersion: RELEASE_ID,
      artifact,
      manifest,
      managedStreamIds: ['core-d1'],
      actorId: 'setup:update',
      now: 10,
      executeBatch,
    });
    database.exec(`
      UPDATE control_operations
         SET status = 'blocked', last_error_code = 'migration_history_checksum_mismatch',
             updated_at = 11
       WHERE operation_id = '${created.operationId}';
      UPDATE control_release_migration_rollouts
         SET handoff_state = 'blocked', updated_at = 11
       WHERE operation_id = '${created.operationId}';
    `);
    await expect(
      waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        operationId: created.operationId,
        executeBatch,
        sleep: async () => undefined,
        timeoutMs: 10,
      })
    ).rejects.toThrow('release_rollout_blocked:migration_history_checksum_mismatch');
  });
});
