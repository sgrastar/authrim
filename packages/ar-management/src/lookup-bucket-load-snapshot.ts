import type { D1Database } from '@cloudflare/workers-types';
import {
  loadVerifiedLookupBucketAssignmentProvider,
  type ControlLookupBucketLoadObservation,
  type ControlLookupBucketLoadSnapshotRequest,
  type Env,
} from '@authrim/ar-lib-core';

const SAFE_BINDING = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const MAX_COUNTER_AGE_SECONDS = 24 * 60 * 60;
const QUERY_CONCURRENCY = 4;

interface CounterRow {
  virtual_bucket: number;
  active_identifier_count: number;
  active_alias_count: number;
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

async function counters(env: Env, bindingRef: string): Promise<Map<number, CounterRow>> {
  const result = await database(env, bindingRef)
    .withSession('first-primary')
    .prepare(
      `SELECT virtual_bucket,
              estimated_active_identifier_count AS active_identifier_count,
              estimated_active_alias_count AS active_alias_count,
              updated_at AS counter_updated_at
         FROM lookup_bucket_counters
        ORDER BY virtual_bucket
        LIMIT 4097`
    )
    .bind()
    .all<CounterRow>();
  if (result.results.length > 4096) throw new Error('lookup_bucket_load_counter_overflow');
  const rows = new Map<number, CounterRow>();
  for (const row of result.results) {
    const virtualBucket = integer(row.virtual_bucket, 0, 'lookup_bucket_load_counter_invalid');
    if (virtualBucket > 4095 || rows.has(virtualBucket)) {
      throw new Error('lookup_bucket_load_counter_invalid');
    }
    rows.set(virtualBucket, {
      virtual_bucket: virtualBucket,
      active_identifier_count: integer(
        row.active_identifier_count,
        0,
        'lookup_bucket_load_counter_invalid'
      ),
      active_alias_count: integer(row.active_alias_count, 0, 'lookup_bucket_load_counter_invalid'),
      counter_updated_at: integer(row.counter_updated_at, 1, 'lookup_bucket_load_counter_invalid'),
    });
  }
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
  if (assignments.size !== 4096) throw new Error('lookup_bucket_load_registry_incomplete');

  const bindingRefs = [
    ...new Set([...assignments.values()].map((value) => value.bindingRef)),
  ].sort();
  const countersByBinding = new Map<string, Map<number, CounterRow>>();
  for (let offset = 0; offset < bindingRefs.length; offset += QUERY_CONCURRENCY) {
    const page = bindingRefs.slice(offset, offset + QUERY_CONCURRENCY);
    const results = await Promise.all(
      page.map(async (bindingRef) => [bindingRef, await counters(env, bindingRef)] as const)
    );
    for (const [bindingRef, rows] of results) countersByBinding.set(bindingRef, rows);
  }

  const buckets: ControlLookupBucketLoadObservation[] = [];
  for (let virtualBucket = 0; virtualBucket < 4096; virtualBucket += 1) {
    const assignment = assignments.get(virtualBucket);
    const row = assignment
      ? countersByBinding.get(assignment.bindingRef)?.get(virtualBucket)
      : undefined;
    if (!assignment || !row) throw new Error('lookup_bucket_load_snapshot_incomplete');
    if (
      row.counter_updated_at > observedAt + 5 ||
      row.counter_updated_at < observedAt - MAX_COUNTER_AGE_SECONDS
    ) {
      throw new Error('lookup_bucket_load_counter_stale');
    }
    buckets.push({
      virtualBucket,
      lookupShardId: assignment.lookupShardId,
      assignmentGeneration: assignment.assignmentGeneration,
      activeIdentifierCount: row.active_identifier_count,
      activeAliasCount: row.active_alias_count,
      counterUpdatedAt: row.counter_updated_at,
    });
  }
  return { ownerId, observedAt, buckets };
}
