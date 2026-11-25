import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOOKUP_HMAC_DUAL_WRITE_MIN_SECONDS,
  LookupHmacKeyStateService,
} from '../lookup-hmac-key-state';
import { LOOKUP_HMAC_VERIFICATION_COMPONENTS } from '../lookup-hmac-candidate-verifier';
import {
  KEY_A,
  KEY_B,
  hmacD1,
  hmacDatabase,
  insertAuthoritativeShards,
} from './support/lookup-hmac-fixtures';

const E = 'test';
let database: DatabaseSync;
let now: number;
let service: LookupHmacKeyStateService;

beforeEach(async () => {
  database = hmacDatabase();
  now = 100;
  service = new LookupHmacKeyStateService(hmacD1(database), () => now);
});
afterEach(() => database.close());

const row = (sql: string) => database.prepare(sql).get();
const START = { candidate: KEY_B, idempotencyKey: 'rotation-a', ownerId: 'owner-a' };

describe('key state initialization', () => {
  it('rejects an unsafe environment and an unknown environment', async () => {
    await expect(service.initialize('a b', { current: KEY_A })).rejects.toThrow(
      'invalid_lookup_hmac_environment'
    );
    await expect(service.initialize('missing', { current: KEY_A })).rejects.toThrow(
      'control_environment_not_found'
    );
  });

  it('creates the stable state once and replays an identical initialization', async () => {
    const created = await service.initialize(E, { current: KEY_A });
    expect(created).toMatchObject({
      stateRevision: 1,
      rotationState: 'stable',
      writeMode: 'current_only',
      current: KEY_A,
      previous: null,
      operationId: null,
      updatedAt: 100,
    });
    now = 500;
    await expect(service.initialize(E, { current: KEY_A })).resolves.toEqual(created);
  });

  it.each([
    ['generation', { ...KEY_A, generation: 2 }],
    ['key id', { ...KEY_A, keyId: 'other-key' }],
    ['slot', { ...KEY_A, slot: 'B' as const }],
    ['fingerprint', { ...KEY_A, fingerprint: 'c'.repeat(64) }],
  ])('conflicts when the stored %s differs', async (_label, current) => {
    await service.initialize(E, { current: KEY_A });
    await expect(service.initialize(E, { current })).rejects.toThrow(
      'lookup_hmac_key_state_initialization_conflict'
    );
  });

  it('conflicts when the stored state is no longer stable', async () => {
    await service.initialize(E, { current: KEY_A });
    await service.start(E, START);
    database.exec("UPDATE control_lookup_hmac_key_states SET rotation_state = 'dual_read'");
    await expect(service.initialize(E, { current: KEY_A })).rejects.toThrow(
      'lookup_hmac_key_state_initialization_conflict'
    );
  });

  it('returns null for an environment without a state', async () => {
    await expect(service.get(E)).resolves.toBeNull();
  });
});

describe('rotation start', () => {
  beforeEach(async () => {
    await service.initialize(E, { current: KEY_A });
  });

  it.each([
    ['an unsafe idempotency key', { idempotencyKey: 'a b' }, 'invalid_lookup_hmac_idempotency_key'],
    ['an unsafe owner', { ownerId: '' }, 'invalid_lookup_hmac_owner'],
  ])('rejects %s', async (_label, patch, code) => {
    await expect(service.start(E, { ...START, ...patch })).rejects.toThrow(code);
  });

  it('rejects an unsafe operation id when reading a rotation', async () => {
    await expect(service.getRotation(E, 'a b')).rejects.toThrow('invalid_lookup_hmac_operation');
    await expect(service.getRotation(E, 'hmac-missing')).resolves.toBeNull();
  });

  it('requires an initialized key state', async () => {
    await expect(service.start('other', START)).rejects.toThrow('lookup_hmac_key_state_not_found');
  });

  it.each([
    ['a skipped generation', { ...KEY_B, generation: 3 }],
    ['the same key id', { ...KEY_B, keyId: KEY_A.keyId }],
    ['the same slot', { ...KEY_B, slot: 'A' as const }],
    ['the same fingerprint', { ...KEY_B, fingerprint: KEY_A.fingerprint }],
  ])('rejects a candidate with %s', async (_label, candidate) => {
    await expect(service.start(E, { ...START, candidate })).rejects.toThrow(
      'invalid_lookup_hmac_rotation_candidate'
    );
  });

  it('starts a distributing rotation under a fresh lease', async () => {
    const started = await service.start(E, START);
    expect(started).toMatchObject({
      state: 'distributing',
      source: KEY_A,
      candidate: KEY_B,
      ownerId: 'owner-a',
      fencingToken: 1,
      leaseExpiresAt: 100 + 120,
      mutationStarted: false,
      sourceRowCount: null,
      currentRowCount: null,
      verificationAttemptCount: 0,
      graceExpiresAt: null,
      updatedAt: 100,
    });
    expect(started.operationId).toMatch(/^hmac-[a-f0-9]{32}$/u);
    expect(
      row(
        `SELECT status, operation_kind, requested_by_type FROM control_operations WHERE operation_id = '${started.operationId}'`
      )
    ).toEqual({ status: 'running', operation_kind: 'hmac_reindex', requested_by_type: 'admin' });
    await expect(service.getRotation(E, started.operationId)).resolves.toEqual(started);
  });

  it('refuses a second rotation while the first still holds the rewrite lease', async () => {
    await service.start(E, START);
    await expect(
      service.start(E, {
        ...START,
        idempotencyKey: 'rotation-b',
        candidate: { ...KEY_B, keyId: 'k3' },
      })
    ).rejects.toThrow('directory_rewrite_lease_active');
  });

  it('refuses to start while another directory rewrite holds the lease', async () => {
    database.exec(`
      INSERT INTO control_operations (
        operation_id, environment_id, operation_kind, idempotency_key, status, requested_by_type,
        attempt_count, created_at, updated_at
      ) VALUES ('rewrite', '${E}', 'lookup_bucket_migration', 'rewrite', 'running', 'admin', 1, 1, 1);
      INSERT INTO control_directory_rewrite_leases (
        environment_id, operation_id, operation_kind, owner_id, fencing_token, checkpoint_json,
        lease_expires_at, mutation_started, updated_at
      ) VALUES ('${E}', 'rewrite', 'lookup_bucket_migration', 'other', 4, '{}', 1000, 0, 1)`);
    await expect(service.start(E, START)).rejects.toThrow('directory_rewrite_lease_active');
    now = 1000;
    const started = await service.start(E, START);
    expect(started.fencingToken).toBe(5);
  });

  it('replays an identical start and rejects a replay with another candidate', async () => {
    const started = await service.start(E, START);
    await expect(service.start(E, START)).resolves.toMatchObject({
      operationId: started.operationId,
    });
    await expect(
      service.start(E, { ...START, candidate: { ...KEY_B, fingerprint: 'd'.repeat(64) } })
    ).rejects.toThrow('lookup_hmac_rotation_idempotency_conflict');
  });
});

describe('rotation progress guards', () => {
  async function reindexing() {
    insertAuthoritativeShards(database);
    await service.initialize(E, { current: KEY_A });
    const started = await service.start(E, START);
    const statement = database.prepare(
      `INSERT INTO control_lookup_hmac_candidate_verifications (
         environment_id, operation_id, verification_phase, worker_script_name, current_digest,
         candidate_digest, observed_state_revision, status, attempt_count, last_error_code,
         verified_at, updated_at
       ) VALUES ('test', ?, ?, ?, ?, ?, ?, 'succeeded', 1, NULL, 100, 100)`
    );
    for (const component of LOOKUP_HMAC_VERIFICATION_COMPONENTS) {
      statement.run(
        started.operationId,
        'distribution',
        `test-${component}`,
        'c'.repeat(64),
        'd'.repeat(64),
        null
      );
    }
    const mutation = { operationId: started.operationId, ownerId: 'owner-a', fencingToken: 1 };
    await service.activate(E, mutation);
    now += LOOKUP_HMAC_DUAL_WRITE_MIN_SECONDS;
    for (const component of LOOKUP_HMAC_VERIFICATION_COMPONENTS) {
      statement.run(started.operationId, 'generation', `test-${component}`, null, null, 2);
    }
    await service.observeGeneration(E, mutation);
    now += 121;
    const claimed = await service.claimNext(E, 'owner-b');
    if (!claimed) throw new Error('missing_claim');
    return {
      operationId: claimed.operationId,
      ownerId: 'owner-b',
      fencingToken: claimed.fencingToken,
    };
  }

  it('rejects checkpoints from an owner or token that does not hold the lease', async () => {
    const lease = await reindexing();
    const checkpoint = { ...lease, checkpoint: { kind: 'account_id' }, sourceRowCount: 1 };
    await expect(service.checkpoint(E, { ...checkpoint, ownerId: 'owner-x' })).rejects.toThrow(
      'lookup_hmac_rotation_stale_lease'
    );
    await expect(
      service.checkpoint(E, { ...checkpoint, fencingToken: lease.fencingToken + 1 })
    ).rejects.toThrow('lookup_hmac_rotation_stale_lease');
    await expect(service.checkpoint(E, checkpoint)).resolves.toMatchObject({ sourceRowCount: 1 });
  });

  it('rejects a checkpoint that is not a plain object or exceeds the size limit', async () => {
    const lease = await reindexing();
    for (const value of [null, [], 'x']) {
      await expect(
        service.checkpoint(E, { ...lease, checkpoint: value as never, sourceRowCount: 1 })
      ).rejects.toThrow('invalid_lookup_hmac_checkpoint');
    }
    await expect(
      service.checkpoint(E, {
        ...lease,
        checkpoint: { pad: 'x'.repeat(70_000) },
        sourceRowCount: 1,
      })
    ).rejects.toThrow('invalid_lookup_hmac_checkpoint');
  });

  it('rejects a checkpoint that lowers the source row count', async () => {
    const lease = await reindexing();
    await service.checkpoint(E, { ...lease, checkpoint: { kind: 'a' }, sourceRowCount: 5 });
    await expect(
      service.checkpoint(E, { ...lease, checkpoint: { kind: 'b' }, sourceRowCount: 4 })
    ).rejects.toThrow('lookup_hmac_rotation_checkpoint_regression');
    await expect(
      service.checkpoint(E, { ...lease, checkpoint: { kind: 'a' }, sourceRowCount: 6 })
    ).rejects.toThrow('lookup_hmac_rotation_checkpoint_conflict');
  });
});
