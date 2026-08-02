import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupHmacKeyStateService } from '../lookup-hmac-key-state';
import { LOOKUP_HMAC_VERIFICATION_COMPONENTS } from '../lookup-hmac-candidate-verifier';

type SqlValue = string | number | null | Uint8Array;
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KEY_A = {
  generation: 1,
  keyId: 'lookup-key-1',
  slot: 'A' as const,
  fingerprint: 'a'.repeat(64),
};
const KEY_B = {
  generation: 2,
  keyId: 'lookup-key-2',
  slot: 'B' as const,
  fingerprint: 'b'.repeat(64),
};

class BoundStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: SqlValue[]
  ) {}

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): BoundStatement {
    return new BoundStatement(
      this.statement,
      values.map((value) => {
        if (
          typeof value === 'string' ||
          typeof value === 'number' ||
          value === null ||
          value instanceof Uint8Array
        ) {
          return value;
        }
        throw new Error('unsupported_test_sqlite_value');
      })
    );
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new PreparedStatement(database.prepare(sql));
    },
    async batch(statements: BoundStatement[]) {
      database.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function insertAuthoritativeShards(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO control_operations (
       operation_id, environment_id, operation_kind, idempotency_key, status,
       requested_by_type, attempt_count, created_at, started_at, completed_at, updated_at
     ) VALUES ('bootstrap', 'test', 'bootstrap', 'bootstrap', 'succeeded',
       'setup', 1, 1, 1, 1, 1);
     INSERT INTO control_environment_resource_policies (
       environment_id, max_concurrent_provisioning, max_ready_spares, max_d1_resources,
       daily_d1_create_budget, target_account_count, created_at, updated_at
     ) VALUES ('test', 2, 2, 1000, 20, 100000, 1, 1);
     INSERT INTO control_residency_partitions (
       environment_id, residency_policy_id, residency_partition, status, created_at, updated_at
     ) VALUES ('test', 'builtin:residency:default', 'default', 'active', 1, 1);
     INSERT INTO control_desired_resources (
       desired_resource_id, environment_id, resource_kind, logical_shard_id,
       deterministic_name, ownership_fingerprint, provisioning_state,
       origin_operation_id, created_at, updated_at
     ) VALUES
       ('resource-core', 'test', 'd1', 'users-1', 'test-users-1', 'owner-core',
        'active', 'bootstrap', 1, 1),
       ('resource-pii', 'test', 'd1', 'pii-1', 'test-pii-1', 'owner-pii',
        'active', 'bootstrap', 1, 1),
       ('resource-lookup', 'test', 'd1', 'lookup-1', 'test-lookup-1', 'owner-lookup',
        'active', 'bootstrap', 1, 1);
     INSERT INTO control_tenant_shards (
       shard_id, environment_id, data_role, residency_policy_id, residency_partition,
       generation, logical_shard_id, binding_ref, d1_desired_resource_id,
       status, created_at, updated_at
     ) VALUES
       ('users-1', 'test', 'tenant_core/users', 'builtin:residency:default', 'default',
        1, 'users-1', 'TDB_USERS_1', 'resource-core', 'active', 1, 1),
       ('pii-1', 'test', 'tenant_pii', 'builtin:residency:default', 'default',
        1, 'pii-1', 'TDB_PII_1', 'resource-pii', 'active', 1, 1);`
  );
  database.exec(
    `INSERT INTO control_lookup_physical_shards (
       lookup_shard_id, environment_id, residency_partition, binding_ref,
       d1_desired_resource_id, status, created_at, updated_at
     ) VALUES ('lookup-1', 'test', 'default', 'LOOKUP_DB_1',
       'resource-lookup', 'active', 1, 1)`
  );
}

describe('Lookup HMAC rotation state machine', () => {
  let database: DatabaseSync;
  let now: number;
  let service: LookupHmacKeyStateService;

  beforeEach(async () => {
    now = 100;
    database = new DatabaseSync(':memory:');
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/001_control_plane.sql'), 'utf8')
    );
    database.exec(
      readFileSync(resolve(REPO_ROOT, 'migrations/control/004_lookup_hmac_key_state.sql'), 'utf8')
    );
    database.exec(
      readFileSync(
        resolve(REPO_ROOT, 'migrations/control/009_lookup_hmac_candidate_verifications.sql'),
        'utf8'
      )
    );
    database.exec(
      `INSERT INTO control_environments (
         environment_id, environment_name, issuer, lifecycle_state, created_at, updated_at
       ) VALUES ('test', 'test', 'urn:authrim:control:test', 'active', 1, 1)`
    );
    service = new LookupHmacKeyStateService(d1(database), () => now);
    await service.initialize('test', { current: KEY_A });
  });

  afterEach(() => database.close());

  function recordCandidateVerification(operationId: string): void {
    const statement = database.prepare(
      `INSERT INTO control_lookup_hmac_candidate_verifications (
         environment_id, operation_id, verification_phase, worker_script_name, current_digest,
         candidate_digest, observed_state_revision, status, attempt_count, last_error_code,
         verified_at, updated_at
       ) VALUES ('test', ?, 'distribution', ?, ?, ?, NULL, 'succeeded', 1, NULL, ?, ?)`
    );
    for (const component of LOOKUP_HMAC_VERIFICATION_COMPONENTS) {
      statement.run(operationId, `test-${component}`, 'c'.repeat(64), 'd'.repeat(64), now, now);
    }
  }

  function recordGenerationObservation(operationId: string): void {
    const statement = database.prepare(
      `INSERT INTO control_lookup_hmac_candidate_verifications (
         environment_id, operation_id, verification_phase, worker_script_name, current_digest,
         candidate_digest, observed_state_revision, status, attempt_count, last_error_code,
         verified_at, updated_at
       ) VALUES ('test', ?, 'generation', ?, NULL, NULL, 2, 'succeeded', 1, NULL, ?, ?)`
    );
    for (const component of LOOKUP_HMAC_VERIFICATION_COMPONENTS) {
      statement.run(operationId, `test-${component}`, now, now);
    }
  }

  it('does not activate before every expected Worker has consistent candidate evidence', async () => {
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-evidence-gate',
      ownerId: 'setup-owner',
    });
    await expect(
      service.activate('test', {
        operationId: started.operationId,
        ownerId: 'setup-owner',
        fencingToken: 1,
      })
    ).rejects.toThrow('lookup_hmac_candidate_verification_incomplete');
    await expect(service.get('test')).resolves.toMatchObject({
      rotationState: 'stable',
      current: KEY_A,
      previous: null,
    });
  });

  it('moves from distribution through dual-write and dual-read into resumable reindex', async () => {
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-1',
      ownerId: 'setup-owner',
    });
    expect(started).toMatchObject({
      state: 'distributing',
      source: KEY_A,
      candidate: KEY_B,
      ownerId: 'setup-owner',
      fencingToken: 1,
      mutationStarted: false,
    });
    recordCandidateVerification(started.operationId);
    const activated = await service.activate('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    expect(activated).toMatchObject({ state: 'activation_dual_write', mutationStarted: true });
    await expect(service.get('test')).resolves.toMatchObject({
      stateRevision: 2,
      rotationState: 'activation_dual_write',
      writeMode: 'dual_write',
      current: KEY_B,
      previous: KEY_A,
      operationId: started.operationId,
    });

    recordGenerationObservation(started.operationId);
    await service.observeGeneration('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    await expect(service.get('test')).resolves.toMatchObject({
      stateRevision: 3,
      rotationState: 'dual_read',
      writeMode: 'current_only',
      current: KEY_B,
      previous: KEY_A,
    });

    now += 121;
    const claimed = await service.claimNext('test', 'scheduled-owner');
    expect(claimed).toMatchObject({
      operationId: started.operationId,
      state: 'reindexing',
      ownerId: 'scheduled-owner',
      fencingToken: 2,
      leaseExpiresAt: now + 90,
      mutationStarted: true,
    });
    if (!claimed) throw new Error('missing_claim');
    const checkpoint = {
      operationId: claimed.operationId,
      ownerId: 'scheduled-owner',
      fencingToken: 2,
      checkpoint: { kind: 'email_exact', after_shard_id: 'pii-1', after_id: 'user-50' },
      sourceRowCount: 50,
    };
    await expect(service.checkpoint('test', checkpoint)).resolves.toMatchObject({
      state: 'reindexing',
      sourceRowCount: 50,
      checkpoint: { kind: 'email_exact', after_shard_id: 'pii-1', after_id: 'user-50' },
    });
    await expect(service.checkpoint('test', checkpoint)).resolves.toMatchObject({
      sourceRowCount: 50,
    });
  });

  it('is idempotent for the same request and rejects candidate reuse or conflict', async () => {
    const request = {
      candidate: KEY_B,
      idempotencyKey: 'rotation-1',
      ownerId: 'setup-owner',
    };
    const first = await service.start('test', request);
    await expect(service.start('test', request)).resolves.toMatchObject({
      operationId: first.operationId,
      candidate: KEY_B,
    });
    await expect(
      service.start('test', {
        ...request,
        candidate: { ...KEY_B, keyId: 'different-key' },
      })
    ).rejects.toThrow('lookup_hmac_rotation_idempotency_conflict');
  });

  it('resumes an expired setup lease with a new fencing token', async () => {
    const request = {
      candidate: KEY_B,
      idempotencyKey: 'rotation-resume',
      ownerId: 'setup-owner',
    };
    const started = await service.start('test', request);
    recordCandidateVerification(started.operationId);

    now += 121;
    const resumedDistribution = await service.start('test', request);
    expect(resumedDistribution).toMatchObject({
      state: 'distributing',
      ownerId: 'setup-owner',
      fencingToken: 2,
      leaseExpiresAt: now + 120,
      mutationStarted: false,
    });
    await expect(
      service.activate('test', {
        operationId: started.operationId,
        ownerId: 'setup-owner',
        fencingToken: 1,
      })
    ).rejects.toThrow('lookup_hmac_rotation_stale_lease');
    await service.activate('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 2,
    });

    now += 121;
    const resumedActivation = await service.start('test', {
      ...request,
      ownerId: 'recovery-owner',
    });
    expect(resumedActivation).toMatchObject({
      state: 'activation_dual_write',
      ownerId: 'recovery-owner',
      fencingToken: 3,
      leaseExpiresAt: now + 120,
      mutationStarted: true,
    });
    recordGenerationObservation(started.operationId);
    await expect(
      service.observeGeneration('test', {
        operationId: started.operationId,
        ownerId: 'setup-owner',
        fencingToken: 2,
      })
    ).rejects.toThrow('lookup_hmac_rotation_stale_lease');
    await expect(
      service.observeGeneration('test', {
        operationId: started.operationId,
        ownerId: 'recovery-owner',
        fencingToken: 3,
      })
    ).resolves.toMatchObject({ state: 'dual_read' });
  });

  it('does not take over an unexpired idempotent operation from another owner', async () => {
    const request = {
      candidate: KEY_B,
      idempotencyKey: 'rotation-active-owner',
      ownerId: 'setup-owner',
    };
    await service.start('test', request);
    await expect(service.start('test', { ...request, ownerId: 'other-owner' })).rejects.toThrow(
      'directory_rewrite_lease_active'
    );
  });

  it('rejects stale fencing without changing checkpoint or counts', async () => {
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-1',
      ownerId: 'setup-owner',
    });
    recordCandidateVerification(started.operationId);
    await service.activate('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    recordGenerationObservation(started.operationId);
    await service.observeGeneration('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    now += 121;
    await service.claimNext('test', 'scheduled-owner');
    await expect(
      service.checkpoint('test', {
        operationId: started.operationId,
        ownerId: 'setup-owner',
        fencingToken: 1,
        checkpoint: { after_id: 'stale' },
        sourceRowCount: 50,
      })
    ).rejects.toThrow('lookup_hmac_rotation_stale_lease');
    const row = database
      .prepare(
        `SELECT authoritative_checkpoint_json, source_row_count
           FROM control_hmac_rotation_operations WHERE operation_id = ?`
      )
      .get(started.operationId);
    expect(row).toEqual({ authoritative_checkpoint_json: '{}', source_row_count: null });
  });

  it('does not let another directory rewrite take over after key activation', async () => {
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-1',
      ownerId: 'setup-owner',
    });
    recordCandidateVerification(started.operationId);
    await service.activate('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    now += 500;
    await expect(
      service.start('test', {
        candidate: { ...KEY_A, generation: 3, keyId: 'lookup-key-3' },
        idempotencyKey: 'rotation-2',
        ownerId: 'other-owner',
      })
    ).rejects.toThrow('lookup_hmac_rotation_active');
    expect(
      database.prepare(`SELECT operation_id FROM control_directory_rewrite_leases`).get()
    ).toEqual({ operation_id: started.operationId });
  });

  it('snapshots every authoritative shard and completes verification and grace', async () => {
    insertAuthoritativeShards(database);
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-sources',
      ownerId: 'setup-owner',
    });
    recordCandidateVerification(started.operationId);
    await service.activate('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    recordGenerationObservation(started.operationId);
    await service.observeGeneration('test', {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: 1,
    });
    expect(
      database
        .prepare(
          `SELECT source_kind, data_role, shard_id, binding_ref
             FROM control_lookup_hmac_rotation_sources ORDER BY source_kind, shard_id`
        )
        .all()
    ).toEqual([
      {
        source_kind: 'account_id',
        data_role: 'tenant_core/users',
        shard_id: 'users-1',
        binding_ref: 'TDB_USERS_1',
      },
      {
        source_kind: 'email_exact',
        data_role: 'tenant_pii',
        shard_id: 'pii-1',
        binding_ref: 'TDB_PII_1',
      },
      {
        source_kind: 'external_subject',
        data_role: 'tenant_pii',
        shard_id: 'pii-1',
        binding_ref: 'TDB_PII_1',
      },
      {
        source_kind: 'external_subject',
        data_role: 'tenant_core/users',
        shard_id: 'users-1',
        binding_ref: 'TDB_USERS_1',
      },
    ]);

    now += 121;
    const claimed = await service.claimNext('test', 'scheduled-owner');
    if (!claimed) throw new Error('missing_claim');
    const mutation = {
      operationId: claimed.operationId,
      ownerId: 'scheduled-owner',
      fencingToken: claimed.fencingToken,
    };
    await expect(service.getNextSource('test', mutation)).resolves.toMatchObject({
      sourceKind: 'account_id',
      shardId: 'users-1',
      state: 'pending',
    });
    for (const [sourceKind, shardId, count] of [
      ['account_id', 'users-1', 2],
      ['email_exact', 'pii-1', 1],
      ['external_subject', 'pii-1', 1],
      ['external_subject', 'users-1', 1],
    ] as const) {
      await service.checkpointSource('test', {
        ...mutation,
        sourceKind,
        shardId,
        cursor: { after_created_at: 10, after_id: `${sourceKind}-last` },
        sourceRowCount: count,
        complete: true,
      });
    }
    await expect(service.getNextSource('test', mutation)).resolves.toBeNull();
    await expect(service.beginVerification('test', mutation)).resolves.toMatchObject({
      state: 'verifying',
      sourceRowCount: 5,
      leaseExpiresAt: now + 90,
    });
    await expect(service.getNextVerificationShard('test', mutation)).resolves.toMatchObject({
      lookupShardId: 'lookup-1',
      bindingRef: 'LOOKUP_DB_1',
      state: 'pending',
    });
    await expect(
      service.recordVerification('test', {
        ...mutation,
        currentRowCount: 4,
        result: {
          sourceShardsComplete: true,
          currentRowsValid: true,
          reservationsValid: true,
          routeReferencesValid: true,
        },
      })
    ).rejects.toThrow('lookup_hmac_verification_evidence_mismatch');
    await service.checkpointVerificationShard('test', {
      ...mutation,
      lookupShardId: 'lookup-1',
      cursor: { done: true },
      currentRowCount: 5,
      result: {
        currentRowsValid: true,
        reservationsValid: true,
        routeReferencesValid: true,
      },
      complete: true,
    });
    await expect(service.getNextVerificationShard('test', mutation)).resolves.toBeNull();
    const grace = await service.finalizeVerification('test', mutation);
    expect(grace).toMatchObject({ state: 'grace', verificationAttemptCount: 1 });
    await expect(service.completeGrace('test', mutation)).rejects.toThrow(
      'lookup_hmac_grace_not_elapsed'
    );

    now += 7 * 24 * 60 * 60 + 1;
    const graceClaim = await service.claimNext('test', 'grace-owner');
    if (!graceClaim) throw new Error('missing_grace_claim');
    const completionMutation = {
      operationId: graceClaim.operationId,
      ownerId: 'grace-owner',
      fencingToken: graceClaim.fencingToken,
    };
    await expect(service.completeGrace('test', completionMutation)).resolves.toMatchObject({
      state: 'complete',
      ownerId: null,
    });
    await expect(service.completeGrace('test', completionMutation)).resolves.toMatchObject({
      state: 'complete',
      ownerId: null,
    });
    await expect(service.get('test')).resolves.toMatchObject({
      rotationState: 'stable',
      previous: null,
      operationId: null,
      current: KEY_B,
    });
  });

  it('restarts authoritative scans twice and blocks on the third failed verification', async () => {
    insertAuthoritativeShards(database);
    const started = await service.start('test', {
      candidate: KEY_B,
      idempotencyKey: 'rotation-failures',
      ownerId: 'setup-owner',
    });
    recordCandidateVerification(started.operationId);
    const setupMutation = {
      operationId: started.operationId,
      ownerId: 'setup-owner',
      fencingToken: started.fencingToken,
    };
    await service.activate('test', setupMutation);
    recordGenerationObservation(started.operationId);
    await service.observeGeneration('test', setupMutation);
    now += 121;
    const claimed = await service.claimNext('test', 'scheduled-owner');
    if (!claimed) throw new Error('missing_claim');
    const mutation = {
      operationId: claimed.operationId,
      ownerId: 'scheduled-owner',
      fencingToken: claimed.fencingToken,
    };
    const completeSources = async () => {
      for (const [sourceKind, shardId] of [
        ['account_id', 'users-1'],
        ['email_exact', 'pii-1'],
        ['external_subject', 'pii-1'],
        ['external_subject', 'users-1'],
      ] as const) {
        await service.checkpointSource('test', {
          ...mutation,
          sourceKind,
          shardId,
          cursor: { done: true },
          sourceRowCount: 1,
          complete: true,
        });
      }
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await completeSources();
      await service.beginVerification('test', mutation);
      await service.checkpointVerificationShard('test', {
        ...mutation,
        lookupShardId: 'lookup-1',
        cursor: { done: true },
        currentRowCount: 3,
        result: {
          currentRowsValid: false,
          reservationsValid: true,
          routeReferencesValid: true,
        },
        complete: true,
      });
      const result = await service.finalizeVerification('test', mutation);
      expect(result).toMatchObject({
        state: attempt === 3 ? 'blocked' : 'reindexing',
        verificationAttemptCount: attempt,
      });
    }
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM control_lookup_hmac_rotation_verification_shards
            WHERE operation_id = ?`
        )
        .get(started.operationId)
    ).toEqual({ count: 1 });
  });
});
