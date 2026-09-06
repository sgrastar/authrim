import type { D1Database } from '@cloudflare/workers-types';
import {
  loadVerifiedLookupBucketAssignmentProvider,
  type ControlLookupBucketLoadObservation,
  type ControlLookupBucketLoadSnapshotRequest,
  type Env,
} from '@authrim/ar-lib-core';
import {
  LOOKUP_MAX_VIRTUAL_BUCKET,
  LOOKUP_VIRTUAL_BUCKET_COUNT,
} from '@authrim/ar-lib-core/services/lookup-directory/contract';

const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const QUERY_CONCURRENCY = 4;
const QUERY_BUCKET_LIMIT = 100;

interface CounterRow {
  virtual_bucket: number;
  active_identifier_count: number;
  active_alias_count: number;
  successful_route_publication_count: number;
  publication_counter_updated_at: number;
  counter_updated_at: number;
}

function database(env: Env, bindingRef: string): D1Database {
  if (!SAFE_BINDING.test(bindingRef)) throw new Error('lookup_bucket_load_binding_invalid');
  const value = (env as unknown as Record<string, unknown>)[bindingRef];
  if (!value || typeof value !== 'object') {
    throw new Error('lookup_bucket_load_binding_unavailable');
  }
  const candidate = value as Partial<D1Database>;
  if (
    typeof candidate.prepare !== 'function' ||
    typeof candidate.batch !== 'function' ||
    typeof candidate.withSession !== 'function'
  ) {
    throw new Error('lookup_bucket_load_binding_unavailable');
  }
  return value as D1Database;
}

function integer(value: unknown, minimum: number, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(code);
  return value as number;
}

async function counters(
  env: Env,
  bindingRef: string,
  assignedBuckets: readonly number[]
): Promise<Map<number, CounterRow>> {
  if (assignedBuckets.length < 1 || assignedBuckets.length > LOOKUP_VIRTUAL_BUCKET_COUNT) {
    throw new Error('lookup_bucket_load_assignment_invalid');
  }
  const uniqueBuckets = new Set<number>();
  for (const virtualBucket of assignedBuckets) {
    integer(virtualBucket, 0, 'lookup_bucket_load_assignment_invalid');
    if (virtualBucket > LOOKUP_MAX_VIRTUAL_BUCKET || uniqueBuckets.has(virtualBucket)) {
      throw new Error('lookup_bucket_load_assignment_invalid');
    }
    uniqueBuckets.add(virtualBucket);
  }
  const session = database(env, bindingRef).withSession('first-primary');
  const statements = [];
  for (let offset = 0; offset < assignedBuckets.length; offset += QUERY_BUCKET_LIMIT) {
    const page = assignedBuckets.slice(offset, offset + QUERY_BUCKET_LIMIT);
    const placeholders = page.map(() => '?').join(', ');
    statements.push(
      session
        .prepare(
          `SELECT virtual_bucket,
                  estimated_active_identifier_count AS active_identifier_count,
                  estimated_active_alias_count AS active_alias_count,
                  successful_route_publication_count,
                  publication_counter_updated_at,
                  updated_at AS counter_updated_at
             FROM lookup_bucket_counters
            WHERE virtual_bucket IN (${placeholders})
            ORDER BY virtual_bucket`
        )
        .bind(...page)
    );
  }
  const results = await session.batch<CounterRow>(statements);
  const rows = new Map<number, CounterRow>();
  for (const result of results) {
    for (const row of result.results) {
      const virtualBucket = integer(row.virtual_bucket, 0, 'lookup_bucket_load_counter_invalid');
      if (
        virtualBucket > LOOKUP_MAX_VIRTUAL_BUCKET ||
        !uniqueBuckets.has(virtualBucket) ||
        rows.has(virtualBucket)
      ) {
        throw new Error('lookup_bucket_load_counter_invalid');
      }
      rows.set(virtualBucket, {
        virtual_bucket: virtualBucket,
        active_identifier_count: integer(
          row.active_identifier_count,
          0,
          'lookup_bucket_load_counter_invalid'
        ),
        active_alias_count: integer(
          row.active_alias_count,
          0,
          'lookup_bucket_load_counter_invalid'
        ),
        successful_route_publication_count: integer(
          row.successful_route_publication_count,
          0,
          'lookup_bucket_load_counter_invalid'
        ),
        publication_counter_updated_at: integer(
          row.publication_counter_updated_at,
          0,
          'lookup_bucket_load_counter_invalid'
        ),
        counter_updated_at: integer(
          row.counter_updated_at,
          1,
          'lookup_bucket_load_counter_invalid'
        ),
      });
    }
  }
  if (rows.size !== assignedBuckets.length)
    throw new Error('lookup_bucket_load_snapshot_incomplete');
  return rows;
}

export async function collectLookupBucketLoadSnapshot(
  env: Env,
  ownerId: string,
  observedAt = Math.floor(Date.now() / 1000)
): Promise<ControlLookupBucketLoadSnapshotRequest> {
  if (!SAFE_ID.test(ownerId)) throw new Error('lookup_bucket_load_owner_invalid');
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (
    !environmentId ||
    !SAFE_ID.test(environmentId) ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 1
  ) {
    throw new Error('lookup_bucket_load_registry_unavailable');
  }
  const provider = await loadVerifiedLookupBucketAssignmentProvider({
    store: env.TENANT_RUNTIME_REGISTRY,
    environmentId,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    now: observedAt,
  });
  const assignments = new Map<
    number,
    { lookupShardId: string; bindingRef: string; assignmentGeneration: number }
  >();
  for (const range of provider.listActiveRanges()) {
    for (
      let virtualBucket = range.startBucket;
      virtualBucket <= range.endBucket;
      virtualBucket += 1
    ) {
      assignments.set(virtualBucket, {
        lookupShardId: range.lookupShardId,
        bindingRef: range.bindingRef,
        assignmentGeneration: range.assignmentGeneration,
      });
    }
  }
  if (assignments.size !== LOOKUP_VIRTUAL_BUCKET_COUNT) {
    throw new Error('lookup_bucket_load_registry_incomplete');
  }

  const bucketsByBinding = new Map<string, number[]>();
  for (const [virtualBucket, assignment] of assignments) {
    const buckets = bucketsByBinding.get(assignment.bindingRef) ?? [];
    buckets.push(virtualBucket);
    bucketsByBinding.set(assignment.bindingRef, buckets);
  }
  const bindingRefs = [...bucketsByBinding.keys()].sort();
  const countersByBinding = new Map<string, Map<number, CounterRow>>();
  for (let offset = 0; offset < bindingRefs.length; offset += QUERY_CONCURRENCY) {
    const page = bindingRefs.slice(offset, offset + QUERY_CONCURRENCY);
    const results = await Promise.all(
      page.map(async (bindingRef) => {
        const buckets = bucketsByBinding.get(bindingRef);
        if (!buckets) throw new Error('lookup_bucket_load_assignment_invalid');
        return [bindingRef, await counters(env, bindingRef, buckets)] as const;
      })
    );
    for (const [bindingRef, rows] of results) countersByBinding.set(bindingRef, rows);
  }

  const buckets: ControlLookupBucketLoadObservation[] = [];
  for (let virtualBucket = 0; virtualBucket < LOOKUP_VIRTUAL_BUCKET_COUNT; virtualBucket += 1) {
    const assignment = assignments.get(virtualBucket);
    const row = assignment
      ? countersByBinding.get(assignment.bindingRef)?.get(virtualBucket)
      : undefined;
    if (!assignment || !row) throw new Error('lookup_bucket_load_snapshot_incomplete');
    // An unchanged bucket legitimately has an old timestamp. The counters are maintained by the
    // same D1 transaction as route lifecycle changes, so absence and future timestamps fail closed;
    // age alone must not stop forecasting for a quiet dynamically bound Lookup shard.
    if (
      row.counter_updated_at > observedAt + 5 ||
      row.publication_counter_updated_at > observedAt + 5
    ) {
      throw new Error('lookup_bucket_load_counter_stale');
    }
    buckets.push({
      virtualBucket,
      lookupShardId: assignment.lookupShardId,
      assignmentGeneration: assignment.assignmentGeneration,
      activeIdentifierCount: row.active_identifier_count,
      activeAliasCount: row.active_alias_count,
      successfulRoutePublicationCount: row.successful_route_publication_count,
      publicationCounterUpdatedAt: row.publication_counter_updated_at,
      counterUpdatedAt: row.counter_updated_at,
    });
  }
  return { ownerId, observedAt, buckets };
}
