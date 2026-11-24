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
  now = 1000;
  service = new LookupBucketMigrationService(bucketD1(database), () => now);
});
afterEach(() => database.close());

function observation(bucket: number, patch: Record<string, unknown> = {}) {
  return {
    virtualBucket: bucket,
    lookupShardId: 'lookup-a',
    assignmentGeneration: bucket === 7 ? 3 : 1,
    activeIdentifierCount: 10,
    activeAliasCount: 0,
    successfulRoutePublicationCount: 10,
    publicationCounterUpdatedAt: now,
    counterUpdatedAt: now,
    ...patch,
  };
}

function snapshot(
  patch: Record<string, unknown> = {},
  buckets = [7, 8, 9].map((b) => observation(b))
) {
  return { ownerId: 'planner', observedAt: now, buckets, ...patch };
}

const plan = (input: unknown) =>
  service.planNextAutomaticMigration(
    E,
    input as Parameters<typeof service.planNextAutomaticMigration>[1]
  );

describe('automatic planning snapshot validation', () => {
  it('rejects unsafe environment and owner identifiers', async () => {
    await expect(service.planNextAutomaticMigration('a b', snapshot() as never)).rejects.toThrow(
      'invalid_lookup_bucket_migration_environment'
    );
    await expect(plan(snapshot({ ownerId: 'a b' }))).rejects.toThrow(
      'invalid_lookup_bucket_migration_owner'
    );
  });

  it.each([
    ['a fractional observation time', { observedAt: 1000.5 }],
    ['an observation older than five minutes', { observedAt: 1000 - 301 }],
    ['an observation more than five seconds ahead', { observedAt: 1000 + 6 }],
    ['no buckets', { buckets: [] }],
    ['a non-array bucket list', { buckets: 'x' }],
  ])('rejects %s', async (_label, patch) => {
    await expect(plan(snapshot(patch))).rejects.toThrow(
      'control_lookup_bucket_load_snapshot_invalid'
    );
  });

  it.each([
    ['five minutes old', -300],
    ['five seconds ahead', 5],
  ])('accepts an observation exactly %s', async (_label, offset) => {
    const observedAt = 1000 + offset;
    const buckets = [7, 8, 9].map((b) =>
      observation(b, { publicationCounterUpdatedAt: observedAt, counterUpdatedAt: observedAt })
    );
    await expect(plan(snapshot({ observedAt }, buckets))).resolves.toMatchObject({
      state: 'dual_write',
    });
  });

  it('requires one observation per assigned bucket', async () => {
    await expect(
      plan(
        snapshot(
          {},
          [7, 8].map((b) => observation(b))
        )
      )
    ).rejects.toThrow('control_lookup_bucket_load_snapshot_incomplete');
  });

  it.each([
    ['a duplicate bucket', (list: Record<string, unknown>[]) => [list[0], list[0], list[2]]],
    [
      'an unsafe shard id',
      (list: Record<string, unknown>[]) => [{ ...list[0], lookupShardId: 'a b' }, list[1], list[2]],
    ],
    [
      'a zero generation',
      (list: Record<string, unknown>[]) => [
        { ...list[0], assignmentGeneration: 0 },
        list[1],
        list[2],
      ],
    ],
    [
      'a negative identifier count',
      (list: Record<string, unknown>[]) => [
        { ...list[0], activeIdentifierCount: -1 },
        list[1],
        list[2],
      ],
    ],
    [
      'a fractional alias count',
      (list: Record<string, unknown>[]) => [
        { ...list[0], activeAliasCount: 0.5 },
        list[1],
        list[2],
      ],
    ],
    [
      'a negative publication count',
      (list: Record<string, unknown>[]) => [
        { ...list[0], successfulRoutePublicationCount: -1 },
        list[1],
        list[2],
      ],
    ],
    [
      'a negative publication timestamp',
      (list: Record<string, unknown>[]) => [
        { ...list[0], publicationCounterUpdatedAt: -1 },
        list[1],
        list[2],
      ],
    ],
    [
      'a publication timestamp ahead of the snapshot',
      (list: Record<string, unknown>[]) => [
        { ...list[0], publicationCounterUpdatedAt: 1006 },
        list[1],
        list[2],
      ],
    ],
    [
      'a fractional counter timestamp',
      (list: Record<string, unknown>[]) => [
        { ...list[0], counterUpdatedAt: 1.5 },
        list[1],
        list[2],
      ],
    ],
    [
      'a counter timestamp ahead of the snapshot',
      (list: Record<string, unknown>[]) => [
        { ...list[0], counterUpdatedAt: 1006 },
        list[1],
        list[2],
      ],
    ],
  ])('rejects an observation with %s', async (_label, mutate) => {
    const list = [7, 8, 9].map((b) => observation(b));
    await expect(plan(snapshot({}, mutate(list) as never))).rejects.toThrow(
      'control_lookup_bucket_load_observation_invalid'
    );
  });

  it.each([
    ['another generation', { assignmentGeneration: 9 }],
    ['another shard', { lookupShardId: 'lookup-b' }],
  ])('rejects an observation with %s than the assignment', async (_label, patch) => {
    const list = [observation(7, patch), observation(8), observation(9)];
    await expect(plan(snapshot({}, list))).rejects.toThrow(
      'control_lookup_bucket_load_assignment_mismatch'
    );
  });

  it('rejects a snapshot while an assignment is mid-migration', async () => {
    database.exec(
      "UPDATE control_lookup_bucket_assignments SET state = 'copying', target_lookup_shard_id = 'lookup-b' WHERE virtual_bucket = 9"
    );
    await expect(plan(snapshot())).rejects.toThrow(
      'control_lookup_bucket_load_assignment_mismatch'
    );
  });

  it('plans nothing when the load is already balanced within its domain', async () => {
    await expect(
      plan(
        snapshot(
          {},
          [7, 8, 9].map((b) => observation(b, { activeIdentifierCount: 0 }))
        )
      )
    ).resolves.toBeNull();
  });
});
