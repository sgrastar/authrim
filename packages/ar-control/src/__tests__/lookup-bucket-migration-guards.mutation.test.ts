import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LookupBucketMigrationService } from '../lookup-bucket-migration';
import { bucketD1, bucketDatabase } from './support/lookup-bucket-fixtures';

const E = 'test';
let database: DatabaseSync;
let now: number;
let service: LookupBucketMigrationService;

beforeEach(() => {
  database = bucketDatabase();
  now = 100;
  service = new LookupBucketMigrationService(bucketD1(database), () => now);
});
afterEach(() => database.close());

const START = {
  virtualBucket: 7,
  targetLookupShardId: 'lookup-b',
  idempotencyKey: 'move-7',
  ownerId: 'planner',
};
const row = (sql: string) => database.prepare(sql).get();

async function claimed() {
  const started = await service.start(E, START);
  const claim = await service.claim(E, { operationId: started.operationId, ownerId: 'planner' });
  return { started, claim };
}

const checkpoint = (
  operationId: string,
  fencingToken: number,
  patch: Record<string, unknown> = {}
) =>
  service.checkpoint(E, {
    operationId,
    ownerId: 'planner',
    fencingToken,
    expectedState: 'dual_write',
    nextState: 'backfilling',
    backfillCursor: '{}',
    sourceRowCount: null,
    targetRowCount: null,
    verificationDigest: null,
    ...patch,
  });

describe('lookup bucket migration request validation', () => {
  it.each([
    ['a negative bucket', { virtualBucket: -1 }, 'invalid_lookup_bucket_migration_bucket'],
    ['a fractional bucket', { virtualBucket: 1.5 }, 'invalid_lookup_bucket_migration_bucket'],
    [
      'a bucket past the last one',
      { virtualBucket: 1_000_000 },
      'invalid_lookup_bucket_migration_bucket',
    ],
    [
      'an unsafe target shard',
      { targetLookupShardId: 'a b' },
      'invalid_lookup_bucket_migration_target',
    ],
    [
      'an unsafe idempotency key',
      { idempotencyKey: '' },
      'invalid_lookup_bucket_migration_idempotency_key',
    ],
    ['an unsafe owner', { ownerId: 'a b' }, 'invalid_lookup_bucket_migration_owner'],
  ])('rejects a start with %s', async (_label, patch, code) => {
    await expect(service.start(E, { ...START, ...patch })).rejects.toThrow(code);
  });

  it('rejects an unsafe environment on every entry point', async () => {
    const code = 'invalid_lookup_bucket_migration_environment';
    await expect(service.start('a b', START)).rejects.toThrow(code);
    await expect(service.claim('a b', { operationId: 'op', ownerId: 'w' })).rejects.toThrow(code);
    await expect(service.writeRoute('a b', 7)).rejects.toThrow(code);
    const cutover = { operationId: 'op', ownerId: 'planner', fencingToken: 1 };
    await expect(
      service.checkpoint('a b', {
        ...cutover,
        expectedState: 'dual_write',
        nextState: 'backfilling',
        backfillCursor: '{}',
        sourceRowCount: null,
        targetRowCount: null,
        verificationDigest: null,
      })
    ).rejects.toThrow(code);
    await expect(service.release('a b', cutover)).rejects.toThrow(code);
    await expect(
      service.block('a b', { ...cutover, errorCode: 'lookup_bucket_migration_x' })
    ).rejects.toThrow(code);
  });

  it('requires the D1 sessions API', async () => {
    const plain = new LookupBucketMigrationService(
      { prepare: () => undefined } as unknown as D1Database,
      () => now
    );
    await expect(plain.start(E, START)).rejects.toThrow('d1_sessions_api_required');
  });

  it('starts one dual-write migration and replays it idempotently', async () => {
    const started = await service.start(E, START);
    expect(started).toMatchObject({
      virtualBucket: 7,
      state: 'dual_write',
      source: { lookupShardId: 'lookup-a' },
      target: { lookupShardId: 'lookup-b' },
    });
    await expect(service.start(E, START)).resolves.toEqual(started);
    expect(row('SELECT COUNT(*) AS n FROM control_lookup_bucket_migrations')).toEqual({ n: 1 });
    await expect(service.start(E, { ...START, virtualBucket: 8 })).rejects.toThrow(
      'control_lookup_bucket_migration_idempotency_conflict'
    );
  });
});

describe('lookup bucket migration claims', () => {
  it('rejects claims for unknown operations', async () => {
    await expect(service.claim(E, { operationId: 'missing', ownerId: 'w' })).rejects.toThrow(
      'control_lookup_bucket_migration_not_found'
    );
  });

  it('renews the lease for the same owner and refuses a second owner', async () => {
    const started = await service.start(E, START);
    const first = await service.claim(E, { operationId: started.operationId, ownerId: 'planner' });
    now = 110;
    const renewed = await service.claim(E, {
      operationId: started.operationId,
      ownerId: 'planner',
    });
    expect(renewed.fencingToken).toBe(first.fencingToken);
    await expect(
      service.claim(E, { operationId: started.operationId, ownerId: 'worker-b' })
    ).rejects.toThrow('directory_rewrite_lease_active');
  });

  it('hands the lease to a new owner with a larger fencing token once it expired', async () => {
    const started = await service.start(E, START);
    const first = await service.claim(E, { operationId: started.operationId, ownerId: 'planner' });
    now = 100_000;
    const takeover = await service.claim(E, {
      operationId: started.operationId,
      ownerId: 'worker-b',
    });
    expect(takeover.fencingToken).toBeGreaterThan(first.fencingToken);
  });
});

describe('lookup bucket migration checkpoints', () => {
  it.each([
    ['a zero fencing token', 0, {}, 'invalid_lookup_bucket_migration_fencing_token'],
    ['a fractional fencing token', 1.5, {}, 'invalid_lookup_bucket_migration_fencing_token'],
    [
      'a skipped state',
      1,
      { expectedState: 'dual_write', nextState: 'verifying' },
      'invalid_lookup_bucket_migration_checkpoint_transition',
    ],
    [
      'a backward state',
      1,
      { expectedState: 'backfilling', nextState: 'dual_write' },
      'invalid_lookup_bucket_migration_checkpoint_transition',
    ],
    [
      'an oversized cursor',
      1,
      { backfillCursor: JSON.stringify({ pad: 'x'.repeat(4096) }) },
      'invalid_lookup_bucket_migration_cursor',
    ],
    ['an unparseable cursor', 1, { backfillCursor: '{' }, 'invalid_lookup_bucket_migration_cursor'],
    ['an array cursor', 1, { backfillCursor: '[]' }, 'invalid_lookup_bucket_migration_cursor'],
    ['a null cursor', 1, { backfillCursor: 'null' }, 'invalid_lookup_bucket_migration_cursor'],
    [
      'a negative source count',
      1,
      { sourceRowCount: -1 },
      'invalid_lookup_bucket_migration_source_count',
    ],
    [
      'a fractional target count',
      1,
      { targetRowCount: 1.5 },
      'invalid_lookup_bucket_migration_target_count',
    ],
    [
      'a short digest',
      1,
      { verificationDigest: 'abc' },
      'invalid_lookup_bucket_migration_verification_digest',
    ],
    [
      'a cutover without counts',
      1,
      {
        expectedState: 'verifying',
        nextState: 'cutover_pending',
        verificationDigest: 'a'.repeat(64),
      },
      'control_lookup_bucket_migration_verification_required',
    ],
    [
      'a cutover with different counts',
      1,
      {
        expectedState: 'verifying',
        nextState: 'cutover_pending',
        sourceRowCount: 3,
        targetRowCount: 4,
        verificationDigest: 'a'.repeat(64),
      },
      'control_lookup_bucket_migration_verification_required',
    ],
    [
      'a cutover without a digest',
      1,
      {
        expectedState: 'verifying',
        nextState: 'cutover_pending',
        sourceRowCount: 3,
        targetRowCount: 3,
      },
      'control_lookup_bucket_migration_verification_required',
    ],
    [
      'a cutover with a malformed digest',
      1,
      {
        expectedState: 'verifying',
        nextState: 'cutover_pending',
        sourceRowCount: 3,
        targetRowCount: 3,
        verificationDigest: 'A'.repeat(64),
      },
      'control_lookup_bucket_migration_verification_required',
    ],
  ])('rejects %s', async (_label, token, patch, code) => {
    await expect(checkpoint('op-1', token, patch)).rejects.toThrow(code);
  });

  it('accepts the largest cursor and records progress through verification', async () => {
    const { started, claim } = await claimed();
    const cursor = JSON.stringify({ pad: 'x'.repeat(4096 - '{"pad":""}'.length) });
    expect(cursor.length).toBe(4096);
    await expect(
      checkpoint(started.operationId, claim.fencingToken, { backfillCursor: cursor })
    ).resolves.toMatchObject({ state: 'backfilling' });
    const verifying = await checkpoint(started.operationId, claim.fencingToken, {
      expectedState: 'backfilling',
      nextState: 'verifying',
      sourceRowCount: 5,
      targetRowCount: 5,
      verificationDigest: 'a'.repeat(64),
    });
    expect(verifying).toMatchObject({ state: 'verifying', sourceRowCount: 5, targetRowCount: 5 });
    await expect(
      checkpoint(started.operationId, claim.fencingToken, {
        expectedState: 'verifying',
        nextState: 'cutover_pending',
        sourceRowCount: 5,
        targetRowCount: 5,
        verificationDigest: 'a'.repeat(64),
      })
    ).resolves.toMatchObject({ state: 'cutover_pending' });
  });

  it('rejects a checkpoint from a stale claim or the wrong state', async () => {
    const { started, claim } = await claimed();
    await expect(checkpoint(started.operationId, claim.fencingToken + 1)).rejects.toThrow(
      'control_lookup_bucket_migration_assignment_stale'
    );
    await expect(
      checkpoint(started.operationId, claim.fencingToken, {
        expectedState: 'backfilling',
        nextState: 'verifying',
      })
    ).rejects.toThrow('control_lookup_bucket_migration_assignment_stale');
  });
});

describe('lookup bucket migration completion paths', () => {
  const cutover = (operationId: string, patch: Record<string, unknown> = {}) => ({
    operationId,
    ownerId: 'planner',
    fencingToken: 1,
    ...patch,
  });

  it.each([
    ['release', (id: string, p: Record<string, unknown>) => service.release(E, cutover(id, p))],
    [
      'prepareCutover',
      (id: string, p: Record<string, unknown>) => service.prepareCutover(E, cutover(id, p)),
    ],
    [
      'confirmCutover',
      (id: string, p: Record<string, unknown>) => service.confirmCutover(E, cutover(id, p), 5),
    ],
    [
      'complete',
      (id: string, p: Record<string, unknown>) =>
        service.complete(E, { ...cutover(id, p), oldRowsQuarantined: true }),
    ],
    [
      'block',
      (id: string, p: Record<string, unknown>) =>
        service.block(E, { ...cutover(id, p), errorCode: 'lookup_bucket_migration_failed' }),
    ],
  ])('%s rejects an unknown operation', async (_name, call) => {
    await expect(call('missing', {})).rejects.toThrow();
  });

  it('validates the block error code and fencing token', async () => {
    for (const errorCode of ['bad', 'lookup_bucket_migration_', 'lookup_bucket_migration_UPPER']) {
      await expect(service.block(E, { ...cutover('op'), errorCode })).rejects.toThrow(
        'invalid_lookup_bucket_migration_error_code'
      );
    }
    await expect(
      service.block(E, {
        ...cutover('op', { fencingToken: 0 }),
        errorCode: 'lookup_bucket_migration_x',
      })
    ).rejects.toThrow('invalid_lookup_bucket_migration_fencing_token');
    await expect(service.release(E, cutover('op', { fencingToken: 0 }))).rejects.toThrow(
      'invalid_lookup_bucket_migration_fencing_token'
    );
    await expect(
      service.block(E, { ...cutover('op'), errorCode: 'lookup_bucket_migration_' + 'a'.repeat(96) })
    ).rejects.toThrow('control_lookup_bucket_migration_not_found');
    await expect(
      service.block(E, { ...cutover('op'), errorCode: 'lookup_bucket_migration_' + 'a'.repeat(97) })
    ).rejects.toThrow('invalid_lookup_bucket_migration_error_code');
  });

  it('blocks and releases a claimed migration exactly once', async () => {
    const { started, claim } = await claimed();
    const blocked = await service.block(E, {
      operationId: started.operationId,
      ownerId: 'planner',
      fencingToken: claim.fencingToken,
      errorCode: 'lookup_bucket_migration_copy_failed',
    });
    expect(blocked).toMatchObject({ state: 'blocked' });
    await expect(
      service.block(E, {
        operationId: started.operationId,
        ownerId: 'planner',
        fencingToken: claim.fencingToken,
        errorCode: 'lookup_bucket_migration_copy_failed',
      })
    ).rejects.toThrow('control_lookup_bucket_migration_state_conflict');
    await expect(
      service.release(E, cutover(started.operationId, { fencingToken: claim.fencingToken }))
    ).rejects.toThrow('control_lookup_bucket_migration_state_conflict');
  });

  it('refuses to prepare a cutover before verification completed', async () => {
    const { started, claim } = await claimed();
    await expect(
      service.prepareCutover(E, cutover(started.operationId, { fencingToken: claim.fencingToken }))
    ).rejects.toThrow('control_lookup_bucket_migration_state_conflict');
  });
});

describe('lookup bucket routes', () => {
  it('validates the bucket and reports unassigned buckets', async () => {
    await expect(service.writeRoute(E, -1)).rejects.toThrow(
      'invalid_lookup_bucket_migration_bucket'
    );
    await expect(service.writeRoute(E, 999_999)).rejects.toThrow(
      'invalid_lookup_bucket_migration_bucket'
    );
    await expect(service.writeRoute(E, 50)).rejects.toThrow(
      'control_lookup_bucket_assignment_not_found'
    );
  });

  it('routes writes to the source and mirrors them to the target during dual write', async () => {
    await expect(service.writeRoute(E, 7)).resolves.toMatchObject({
      primary: { lookupShardId: 'lookup-a', bindingRef: 'LOOKUP_A', assignmentGeneration: 3 },
      mirrors: [],
    });
    await service.start(E, START);
    const route = await service.writeRoute(E, 7);
    expect(route.primary.lookupShardId).toBe('lookup-a');
    expect(route.mirrors.map((mirror) => mirror.lookupShardId)).toEqual(['lookup-b']);
  });

  it.each([0, -1, 1.5])('rejects the assignment generation %s', async (generation) => {
    await expect(service.resolveRouteVersion(E, 7, generation)).rejects.toThrow(
      'invalid_lookup_bucket_assignment_generation'
    );
  });

  it('resolves the primary and mirror generations and rejects unknown ones', async () => {
    await service.start(E, START);
    await expect(service.resolveRouteVersion(E, 7, 3)).resolves.toMatchObject({
      lookupShardId: 'lookup-a',
    });
    const route = await service.writeRoute(E, 7);
    const mirror = route.mirrors[0];
    expect(mirror).toBeDefined();
    if (mirror) {
      await expect(
        service.resolveRouteVersion(E, 7, mirror.assignmentGeneration)
      ).resolves.toMatchObject({ lookupShardId: 'lookup-b' });
    }
    await expect(service.resolveRouteVersion(E, 7, 99)).rejects.toThrow();
  });
});

describe('lookup bucket cutover confirmation', () => {
  const request = { operationId: 'op', ownerId: 'planner', fencingToken: 1 };

  it.each([0, -1, 1.5])('rejects the registry generation %s', async (generation) => {
    await expect(service.confirmCutover(E, request, generation)).rejects.toThrow(
      'control_lookup_bucket_migration_registry_generation_invalid'
    );
  });

  it('requires the cutover to be prepared and the old rows to be quarantined', async () => {
    const { started, claim } = await claimed();
    await expect(
      service.confirmCutover(
        E,
        { operationId: started.operationId, ownerId: 'planner', fencingToken: claim.fencingToken },
        5
      )
    ).rejects.toThrow('control_lookup_bucket_migration_state_conflict');
    await expect(
      service.complete(E, {
        ...request,
        oldRowsQuarantined: false as unknown as true,
      })
    ).rejects.toThrow('control_lookup_bucket_migration_quarantine_required');
  });
});
