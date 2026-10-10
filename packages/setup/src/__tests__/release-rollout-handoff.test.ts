import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { D1BatchExecutionResult, D1BatchStatement } from '../core/cloudflare.js';
import type { MigrationReleaseArtifactPlan } from '../core/migration-release-publication.js';
import type { ReleaseMigrationManifest } from '../core/release-migrations.js';
import {
  RELEASE_TARGET_SET_MISMATCH_CODE,
  beginReleaseRolloutVerification,
  buildReleaseRolloutHandoffPlan,
  completeReleaseRolloutHandoff,
  createReleaseRolloutHandoff,
  getActiveReleaseRolloutHandoffStatus,
  getReleaseRolloutHandoffStatus,
  waitForReleaseRolloutAwaitingSetup,
  formatReleaseRolloutProgress,
  CONTROL_RESUME_GRACE_MS,
  type ReleaseRolloutWaitContext,
} from '../core/release-rollout-handoff.js';

type SqliteValue = string | number | bigint | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIGEST = 'a'.repeat(64);
const RELEASE_ID = '0.5.0';
const OBJECT_KEY = `releases/${RELEASE_ID}/${DIGEST}/manifest.json`;

function applyControlMigrations(target: DatabaseSync): void {
  const directory = resolve(REPO_ROOT, 'migrations/control/d1');
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    target.exec(readFileSync(resolve(directory, file), 'utf8'));
  }
}

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
    applyControlMigrations(database);
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

  describe('expected target set', () => {
    const SET = [
      { streamId: 'pii-d1', databaseId: 'db-pii' },
      { streamId: 'core-d1', databaseId: 'db-core' },
      { streamId: 'core-d1', databaseId: 'db-core' },
    ];
    const CANONICAL = JSON.stringify([
      { streamId: 'core-d1', databaseId: 'db-core' },
      { streamId: 'pii-d1', databaseId: 'db-pii' },
    ]);

    function create(
      expectedTargets?: readonly { streamId: string; databaseId: string }[] | null,
      now = 10,
      rearmBlockedTargetSetMismatch = false
    ) {
      const { manifest, artifact } = fixture();
      return createReleaseRolloutHandoff({
        controlDatabaseId: '01234567-89ab-cdef',
        environmentId: 'env-test',
        sourceVersion: '0.4.0',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1', 'pii-d1'],
        expectedTargets,
        rearmBlockedTargetSetMismatch,
        actorId: 'setup:update',
        now,
        executeBatch,
      });
    }

    function stored(): { expected_targets_json: string | null } {
      return database
        .prepare(`SELECT expected_targets_json FROM control_release_migration_rollouts`)
        .get() as { expected_targets_json: string | null };
    }

    it('binds nothing unless a set is supplied', async () => {
      const { manifest, artifact } = fixture();
      const base = {
        environmentId: 'env-test',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1', 'pii-d1'],
        actorId: 'setup:update',
        now: 10,
      };
      const without = buildReleaseRolloutHandoffPlan(base);
      expect(without.expectedTargetsJson).toBeNull();
      // No re-arm statements either: the plan is the one every other rollout has always had.
      expect(
        buildReleaseRolloutHandoffPlan({ ...base, expectedTargets: [] }).statements.length
      ).toBe(without.statements.length);
      expect(
        buildReleaseRolloutHandoffPlan({
          ...base,
          expectedTargets: [],
          rearmBlockedTargetSetMismatch: true,
        }).statements.length
      ).toBe(without.statements.length + 3);

      await create();
      expect(stored()).toEqual({ expected_targets_json: null });
    });

    it('persists the verified set in canonical form and verifies it on every re-create', async () => {
      await create(SET);
      expect(stored()).toEqual({ expected_targets_json: CANONICAL });

      await expect(create([...SET].reverse(), 11)).resolves.toMatchObject({ phase: 'requested' });
      expect(stored()).toEqual({ expected_targets_json: CANONICAL });
    });

    it('can bind an empty set (no managed tenant databases yet)', async () => {
      await create([]);
      expect(stored()).toEqual({ expected_targets_json: '[]' });
    });

    it('rejects a re-create whose set differs from the stored one', async () => {
      await create(SET);

      await expect(create([{ streamId: 'core-d1', databaseId: 'db-core' }], 11)).rejects.toThrow(
        'release_rollout_expected_targets_mismatch'
      );
      await expect(
        create([...SET, { streamId: 'core-d1', databaseId: 'db-late' }], 11)
      ).rejects.toThrow('release_rollout_expected_targets_mismatch');
      await expect(create(null, 11)).rejects.toThrow('release_rollout_expected_targets_mismatch');
      expect(stored()).toEqual({ expected_targets_json: CANONICAL });
    });

    it('rejects a set supplied for a rollout that was created without one', async () => {
      await create();

      await expect(create(SET, 11)).rejects.toThrow('release_rollout_expected_targets_mismatch');
      expect(stored()).toEqual({ expected_targets_json: null });
    });

    it('rejects sets that name an unmanaged stream or an unsafe database id', async () => {
      await expect(create([{ streamId: 'lookup-d1', databaseId: 'db-x' }])).rejects.toThrow(
        'release_rollout_expected_targets_invalid'
      );
      await expect(create([{ streamId: 'core-d1', databaseId: "db'; --" }])).rejects.toThrow(
        'release_rollout_expected_targets_invalid'
      );
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM control_release_migration_rollouts`).get()
      ).toEqual({ count: 0 });
    });

    describe('re-arm after Control blocked the rollout on a target set mismatch', () => {
      async function blockedByMismatch(code = RELEASE_TARGET_SET_MISMATCH_CODE) {
        const created = await create(SET);
        database.exec(`
          UPDATE control_operations
             SET status = 'running', lock_owner = 'release-snapshot:x', lock_expires_at = 99,
                 attempt_count = 1, updated_at = 11
           WHERE operation_id = '${created.operationId}';
          UPDATE control_operation_steps
             SET status = 'blocked', last_error_code = '${code}', progress_current = 0,
                 progress_total = 0, updated_at = 11
           WHERE operation_id = '${created.operationId}' AND step_key = 'apply_managed_migrations';
          UPDATE control_operations
             SET status = 'blocked', last_error_code = '${code}', lock_owner = NULL,
                 lock_expires_at = NULL, updated_at = 11
           WHERE operation_id = '${created.operationId}';
          UPDATE control_release_migration_rollouts
             SET handoff_state = 'blocked', updated_at = 11
           WHERE operation_id = '${created.operationId}';
        `);
        return created.operationId;
      }

      function snapshot(operationId: string) {
        return database
          .prepare(
            `SELECT rollout.handoff_state, rollout.expected_targets_json,
                    operation.status AS operation_status,
                    operation.last_error_code, operation.lock_owner, operation.lock_expires_at,
                    (SELECT status FROM control_operation_steps
                      WHERE operation_id = rollout.operation_id
                        AND step_key = 'apply_managed_migrations') AS step_status
               FROM control_release_migration_rollouts rollout
               JOIN control_operations operation ON operation.operation_id = rollout.operation_id
              WHERE rollout.operation_id = ?`
          )
          .get(operationId);
      }

      it('replaces the set and hands the rollout back to Control for a new snapshot', async () => {
        const operationId = await blockedByMismatch();
        const recomputed = [...SET, { streamId: 'core-d1', databaseId: 'db-late' }];

        await expect(create(recomputed, 20, true)).resolves.toMatchObject({
          operationId,
          phase: 'requested',
          lastErrorCode: null,
        });

        expect(snapshot(operationId)).toEqual({
          handoff_state: 'requested',
          expected_targets_json: JSON.stringify([
            { streamId: 'core-d1', databaseId: 'db-core' },
            { streamId: 'core-d1', databaseId: 'db-late' },
            { streamId: 'pii-d1', databaseId: 'db-pii' },
          ]),
          operation_status: 'running',
          last_error_code: null,
          lock_owner: 'setup:target-set-rearm',
          lock_expires_at: 1,
          step_status: 'blocked',
        });
        expect(
          database
            .prepare(
              `SELECT actor_type, outcome, redacted_payload_json FROM control_audit_events
                WHERE operation_id = ?
                  AND event_type = 'control.release_migration.target_set_rearmed'`
            )
            .all(operationId)
        ).toEqual([
          {
            actor_type: 'setup',
            outcome: 'succeeded',
            redacted_payload_json: JSON.stringify({
              previous_error_code: RELEASE_TARGET_SET_MISMATCH_CODE,
              expected_target_count: 3,
            }),
          },
        ]);
      });

      it('does not re-arm without a recomputed set', async () => {
        const operationId = await blockedByMismatch();
        const before = snapshot(operationId);

        await expect(create(null, 20, true)).rejects.toThrow(
          'release_rollout_expected_targets_mismatch'
        );

        expect(snapshot(operationId)).toEqual(before);
      });

      it('does not touch a rollout blocked for any other reason', async () => {
        const operationId = await blockedByMismatch('migration_history_checksum_mismatch');
        const before = snapshot(operationId);

        await expect(
          create([{ streamId: 'core-d1', databaseId: 'db-new' }], 20, true)
        ).rejects.toThrow('release_rollout_expected_targets_mismatch');

        expect(snapshot(operationId)).toEqual(before);
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM control_audit_events
                WHERE event_type = 'control.release_migration.target_set_rearmed'`
            )
            .get()
        ).toEqual({ count: 0 });
      });

      it('never re-arms from a plain idempotent create, even with the stored set', async () => {
        const operationId = await blockedByMismatch();
        const before = snapshot(operationId);

        // The second handoff call of a run (and any call without the explicit fresh-run flag).
        await expect(create(SET, 20)).resolves.toMatchObject({ operationId, phase: 'blocked' });
        await expect(create([...SET].reverse(), 21, false)).resolves.toMatchObject({
          phase: 'blocked',
        });

        expect(snapshot(operationId)).toEqual(before);
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM control_audit_events
                WHERE event_type = 'control.release_migration.target_set_rearmed'`
            )
            .get()
        ).toEqual({ count: 0 });
      });

      it('keeps a block that Control raises after the first call of the same run', async () => {
        const operationId = await blockedByMismatch();
        // First call of a fresh run: re-verified set, explicit re-arm.
        await create(SET, 20, true);
        expect(snapshot(operationId)).toMatchObject({ handoff_state: 'requested' });
        // Control snapshots again and blocks once more within the same run.
        database.exec(`
          UPDATE control_operations
             SET status = 'running', lock_owner = 'release-snapshot:y', lock_expires_at = 99,
                 attempt_count = 2, updated_at = 21
           WHERE operation_id = '${operationId}';
          UPDATE control_operations
             SET status = 'blocked', last_error_code = '${RELEASE_TARGET_SET_MISMATCH_CODE}',
                 lock_owner = NULL, lock_expires_at = NULL, updated_at = 22
           WHERE operation_id = '${operationId}';
          UPDATE control_release_migration_rollouts
             SET handoff_state = 'blocked', updated_at = 22
           WHERE operation_id = '${operationId}';
        `);
        const blocked = snapshot(operationId);

        // The second call of the run reuses the earlier set and must not clear the block.
        await expect(create(SET, 23)).resolves.toMatchObject({ phase: 'blocked' });

        expect(snapshot(operationId)).toEqual(blocked);
        await expect(
          waitForReleaseRolloutAwaitingSetup({
            controlDatabaseId: '01234567-89ab-cdef',
            environmentId: 'env-test',
            operationId,
            executeBatch,
            sleep: async () => undefined,
            timeoutMs: 10,
          })
        ).rejects.toThrow('release_rollout_blocked:release_target_set_mismatch');
        // A new run that recomputed the set may re-arm it again.
        await create(SET, 30, true);
        expect(snapshot(operationId)).toMatchObject({ handoff_state: 'requested' });
      });

      it('leaves a running rollout and its set alone when the same set is supplied again', async () => {
        const created = await create(SET);
        const before = snapshot(created.operationId);

        await create([...SET].reverse(), 20, true);

        expect(snapshot(created.operationId)).toEqual(before);
      });
    });
  });

  describe('blocked rollouts that Control resumes by itself', () => {
    const DATABASE_ID = '01234567-89ab-cdef';

    async function createRollout(): Promise<string> {
      const { manifest, artifact } = fixture();
      const created = await createReleaseRolloutHandoff({
        controlDatabaseId: DATABASE_ID,
        environmentId: 'env-test',
        targetVersion: RELEASE_ID,
        artifact,
        manifest,
        managedStreamIds: ['core-d1'],
        actorId: 'setup:update',
        now: 10,
        executeBatch,
      });
      return created.operationId;
    }

    function block(operationId: string, code: string): void {
      database.exec(`
        UPDATE control_operations
           SET status = 'blocked', last_error_code = '${code}', updated_at = 11
         WHERE operation_id = '${operationId}';
        UPDATE control_release_migration_rollouts
           SET handoff_state = 'blocked', updated_at = 11
         WHERE operation_id = '${operationId}';
      `);
    }

    function setPhase(operationId: string, phase: string): void {
      database.exec(`
        UPDATE control_operations
           SET status = 'running', last_error_code = NULL, updated_at = 12
         WHERE operation_id = '${operationId}';
        UPDATE control_release_migration_rollouts
           SET handoff_state = '${phase}', updated_at = 12
         WHERE operation_id = '${operationId}';
      `);
    }

    function harness(startAt = 1_000) {
      let currentTime = startAt;
      const sleeps: number[] = [];
      return {
        now: () => currentTime,
        sleeps,
        clock: () => currentTime,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds);
          currentTime += milliseconds;
        },
      };
    }

    it.each([
      'migration_artifact_manifest_invalid',
      'release_target_provider_database_unavailable',
      'release_migration_executor_unavailable',
    ])('keeps waiting while %s is blocked and returns once Control resumes it', async (code) => {
      const operationId = await createRollout();
      block(operationId, code);
      const time = harness();
      const resumeAt = time.now() + 70_000;
      const contexts: Array<ReleaseRolloutWaitContext | undefined> = [];

      const status = await waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: DATABASE_ID,
        environmentId: 'env-test',
        operationId,
        executeBatch,
        timeoutMs: 30_000,
        pollIntervalMs: 5_000,
        clock: time.clock,
        sleep: async (milliseconds) => {
          await time.sleep(milliseconds);
          // Control's cron resumes the rollout, which then reaches awaiting_setup.
          if (time.now() >= resumeAt) setPhase(operationId, 'awaiting_setup');
        },
        onProgress: (_status, context) => contexts.push(context),
      });

      expect(status.phase).toBe('awaiting_setup');
      const waiting = contexts.filter((context) => context?.awaitingControlResume);
      expect(waiting.length).toBeGreaterThan(5);
      expect(waiting[0]?.awaitingControlResume).toMatchObject({
        errorCode: code,
        graceMs: CONTROL_RESUME_GRACE_MS,
      });
    });

    it('gives the resumed migration a fresh observation window after the grace wait', async () => {
      const operationId = await createRollout();
      block(operationId, 'migration_artifact_manifest_invalid');
      const time = harness();
      const resumeAt = time.now() + 90_000;

      const status = await waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: DATABASE_ID,
        environmentId: 'env-test',
        operationId,
        executeBatch,
        timeoutMs: 30_000,
        pollIntervalMs: 5_000,
        clock: time.clock,
        sleep: async (milliseconds) => {
          await time.sleep(milliseconds);
          // Resumed into database_rollout, which keeps running past the original 30s budget.
          if (time.now() >= resumeAt) setPhase(operationId, 'database_rollout');
        },
      });

      // Not an error: the caller reports "continues safely in Control" for a non-final phase.
      expect(status.phase).toBe('database_rollout');
      expect(time.now() - resumeAt).toBeGreaterThanOrEqual(30_000);
      expect(time.now() - resumeAt).toBeLessThan(40_000);
    });

    it('fails with the original code and a hint when Control never resumes the rollout', async () => {
      const operationId = await createRollout();
      block(operationId, 'migration_artifact_manifest_invalid');
      const time = harness();

      const failure = waitForReleaseRolloutAwaitingSetup({
        controlDatabaseId: DATABASE_ID,
        environmentId: 'env-test',
        operationId,
        executeBatch,
        timeoutMs: 30_000,
        pollIntervalMs: 5_000,
        clock: time.clock,
        sleep: time.sleep,
      });
      await expect(failure).rejects.toThrow(
        'release_rollout_blocked:migration_artifact_manifest_invalid'
      );
      await expect(failure).rejects.toThrow(/Control did not resume the rollout within 180s/u);
      expect(time.now() - 1_000).toBe(CONTROL_RESUME_GRACE_MS);
    });

    it('honours a custom grace period', async () => {
      const operationId = await createRollout();
      block(operationId, 'release_migration_executor_unavailable');
      const time = harness();
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          controlResumeGraceMs: 12_000,
          pollIntervalMs: 5_000,
          clock: time.clock,
          sleep: time.sleep,
        })
      ).rejects.toThrow('release_rollout_blocked:release_migration_executor_unavailable');
      expect(time.now() - 1_000).toBe(12_000);
    });

    it.each([
      'migration_history_checksum_mismatch',
      'operator_action_required',
      'release_migration_target_blocked',
    ])('fails immediately without waiting for %s', async (code) => {
      const operationId = await createRollout();
      block(operationId, code);
      const time = harness();
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          clock: time.clock,
          sleep: time.sleep,
        })
      ).rejects.toThrow(new RegExp(`^release_rollout_blocked:${code}$`, 'u'));
      expect(time.sleeps).toEqual([]);
    });

    it('fails immediately when the blocked rollout has no error code', async () => {
      const operationId = await createRollout();
      block(operationId, 'x');
      database.exec(
        `UPDATE control_operations SET last_error_code = NULL WHERE operation_id = '${operationId}'`
      );
      const time = harness();
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          clock: time.clock,
          sleep: time.sleep,
        })
      ).rejects.toThrow(/^release_rollout_blocked:unknown$/u);
      expect(time.sleeps).toEqual([]);
    });

    it('fails immediately when the rollout changes to a code that needs an operator', async () => {
      const operationId = await createRollout();
      block(operationId, 'migration_artifact_manifest_invalid');
      const time = harness();
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          clock: time.clock,
          sleep: async (milliseconds) => {
            await time.sleep(milliseconds);
            if (time.sleeps.length === 3) block(operationId, 'migration_history_checksum_mismatch');
          },
        })
      ).rejects.toThrow(/^release_rollout_blocked:migration_history_checksum_mismatch$/u);
      expect(time.sleeps).toHaveLength(3);
    });

    it('restarts the grace period when the rollout leaves blocked and comes back', async () => {
      const operationId = await createRollout();
      block(operationId, 'migration_artifact_manifest_invalid');
      const time = harness();
      const start = time.now();
      let unblockedAt = 0;
      let reblockedAt = 0;

      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          timeoutMs: 600_000,
          pollIntervalMs: 5_000,
          clock: time.clock,
          sleep: async (milliseconds) => {
            await time.sleep(milliseconds);
            const elapsed = time.now() - start;
            if (elapsed === 150_000 && !unblockedAt) {
              // Resumed with 30s of the first grace left, then blocked again right away.
              unblockedAt = time.now();
              setPhase(operationId, 'database_rollout');
            } else if (unblockedAt && !reblockedAt) {
              reblockedAt = time.now();
              block(operationId, 'migration_artifact_manifest_invalid');
            }
          },
        })
      ).rejects.toThrow('release_rollout_blocked:migration_artifact_manifest_invalid');

      expect(unblockedAt).toBeGreaterThan(0);
      expect(reblockedAt).toBeGreaterThan(unblockedAt);
      // The second block got its own full grace period (the first would have ended at +180s).
      expect(time.now() - reblockedAt).toBeGreaterThanOrEqual(CONTROL_RESUME_GRACE_MS);
      expect(time.now() - start).toBeGreaterThan(CONTROL_RESUME_GRACE_MS);
    });

    it('rejects an invalid grace period', async () => {
      const operationId = await createRollout();
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          controlResumeGraceMs: -1,
        })
      ).rejects.toThrow('release_rollout_control_resume_grace_invalid');
    });

    it('names the blocking code in the progress message while waiting for Control', async () => {
      const operationId = await createRollout();
      block(operationId, 'migration_artifact_manifest_invalid');
      const time = harness();
      const messages: string[] = [];
      await expect(
        waitForReleaseRolloutAwaitingSetup({
          controlDatabaseId: DATABASE_ID,
          environmentId: 'env-test',
          operationId,
          executeBatch,
          controlResumeGraceMs: 10_000,
          pollIntervalMs: 5_000,
          clock: time.clock,
          sleep: time.sleep,
          onProgress: (status, context) =>
            messages.push(formatReleaseRolloutProgress(status, context)),
        })
      ).rejects.toThrow('release_rollout_blocked');
      expect(messages[0]).toBe(
        'Control database rollout is blocked (migration_artifact_manifest_invalid); waiting for Control to resume it (0s/10s)'
      );
      expect(messages[1]).toContain('(5s/10s)');
    });

    it('formats the normal progress message', async () => {
      const operationId = await createRollout();
      const status = await getReleaseRolloutHandoffStatus({
        controlDatabaseId: DATABASE_ID,
        environmentId: 'env-test',
        operationId,
        executeBatch,
      });
      expect(formatReleaseRolloutProgress(status)).toBe(
        'Control database rollout: 0/0 (requested)'
      );
    });
  });
});
