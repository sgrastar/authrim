import type { D1Database, D1DatabaseSession } from '@cloudflare/workers-types';
import {
  loadVerifiedLookupBucketAssignmentProvider,
  validateAccountRouteProjection,
  type AccountRouteProjection,
  type ControlTenantPlacementMigrationView,
  type Env,
  type LookupShardRegistryRange,
} from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const SAFE_BINDING_REF = /^[A-Z][A-Z0-9_]{0,127}$/u;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const MAX_EMPTY_RANGES_PER_PAGE = 16;

interface LookupRouteRow {
  row_id: number | string;
  virtual_bucket: number | string;
  account_route_generation: number | string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: string;
}

export interface TenantPlacementLookupCutoverCursor {
  rangesDigest: string;
  rangeIndex: number;
  rowId: number;
}

export interface TenantPlacementLookupCutoverPageResult {
  phase: 'prepare' | 'activate' | 'verify';
  processedRows: number;
  complete: boolean;
  cursor: TenantPlacementLookupCutoverCursor | null;
}

interface TenantPlacementLookupCutoverDependencies {
  ranges?: LookupShardRegistryRange[];
  resolveBinding?: (bindingRef: string) => D1Database;
}

function positiveInteger(value: unknown, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function binding(env: Env, bindingRef: string): D1Database {
  if (!SAFE_BINDING_REF.test(bindingRef)) {
    throw new Error('tenant_placement_lookup_binding_invalid');
  }
  const value = (env as unknown as Record<string, unknown>)[bindingRef] as
    | Partial<D1Database>
    | undefined;
  if (!value || typeof value.withSession !== 'function') {
    throw new Error('tenant_placement_lookup_binding_unavailable');
  }
  return value as D1Database;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalRanges(ranges: LookupShardRegistryRange[]): LookupShardRegistryRange[] {
  if (ranges.length < 1 || ranges.length > 4096) {
    throw new Error('tenant_placement_lookup_ranges_invalid');
  }
  let nextBucket = 0;
  return ranges
    .map((range) => {
      if (
        range.startBucket !== nextBucket ||
        !Number.isSafeInteger(range.endBucket) ||
        range.endBucket < range.startBucket ||
        range.endBucket > 4095 ||
        !SAFE_ID.test(range.lookupShardId) ||
        !SAFE_BINDING_REF.test(range.bindingRef) ||
        !Number.isSafeInteger(range.assignmentGeneration) ||
        range.assignmentGeneration < 1
      ) {
        throw new Error('tenant_placement_lookup_ranges_invalid');
      }
      nextBucket = range.endBucket + 1;
      return { ...range };
    })
    .map((range, index, all) => {
      if (index === all.length - 1 && range.endBucket !== 4095) {
        throw new Error('tenant_placement_lookup_ranges_invalid');
      }
      return range;
    });
}

function routeMap(migration: ControlTenantPlacementMigrationView) {
  if (
    migration.targetIsolationPolicy !== 'tenant_exclusive' ||
    !migration.routeCutoverStarted ||
    migration.writeFenceState !== 'active' ||
    !['cutover_ready', 'cutover_committed'].includes(migration.state)
  ) {
    throw new Error('tenant_placement_lookup_cutover_not_ready');
  }
  const result = new Map<
    string,
    NonNullable<ControlTenantPlacementMigrationView['shards'][number]['target']>
  >();
  for (const shard of migration.shards) {
    if (
      !shard.target ||
      shard.state !== (migration.state === 'cutover_ready' ? 'write_fenced' : 'cutover_committed')
    ) {
      throw new Error('tenant_placement_lookup_target_incomplete');
    }
    const key = `${shard.dataRole}\0${shard.residencyPartition}\0${shard.sourceShardId}`;
    if (result.has(key)) throw new Error('tenant_placement_lookup_target_ambiguous');
    result.set(key, shard.target);
  }
  return result;
}

function replaceProjection(
  value: string,
  mapping: ReturnType<typeof routeMap>
): AccountRouteProjection {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new Error('tenant_placement_lookup_projection_invalid');
  }
  let source: AccountRouteProjection;
  try {
    source = validateAccountRouteProjection(JSON.parse(value) as AccountRouteProjection);
  } catch {
    throw new Error('tenant_placement_lookup_projection_invalid');
  }
  const targets = source.targets.map((target) => {
    const replacement = mapping.get(
      `${target.dataRole}\0${target.residencyPartition}\0${target.shardId}`
    );
    if (!replacement) {
      const keyPrefix = `${target.dataRole}\0${target.residencyPartition}\0`;
      const alreadyTarget = [...mapping.entries()].find(
        ([key, candidate]) =>
          key.startsWith(keyPrefix) &&
          candidate.shardId === target.shardId &&
          candidate.bindingRef === target.bindingRef &&
          candidate.routeGeneration === target.requiredBindingRouteGeneration
      );
      if (!alreadyTarget) throw new Error('tenant_placement_lookup_source_route_unmapped');
      return { ...target };
    }
    return {
      dataRole: target.dataRole,
      residencyPartition: target.residencyPartition,
      shardId: replacement.shardId,
      bindingRef: replacement.bindingRef,
      requiredBindingRouteGeneration: replacement.routeGeneration,
    };
  });
  return validateAccountRouteProjection({
    schemaVersion: source.schemaVersion,
    accountRouteGeneration: source.accountRouteGeneration,
    residencyPolicyId: source.residencyPolicyId,
    targets,
  });
}

async function reflectedRows(
  session: D1DatabaseSession,
  rowIds: number[]
): Promise<LookupRouteRow[]> {
  if (rowIds.length === 0) return [];
  const placeholders = rowIds.map(() => '?').join(', ');
  const reflected = await session
    .prepare(
      `SELECT rowid AS row_id, virtual_bucket, account_route_generation,
              route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state
         FROM lookup_identifiers WHERE rowid IN (${placeholders}) ORDER BY rowid`
    )
    .bind(...rowIds)
    .all<LookupRouteRow>();
  return reflected.results;
}

export async function processTenantPlacementLookupCutoverPage(
  env: Env,
  input: {
    tenantId: string;
    migration: ControlTenantPlacementMigrationView;
    phase: 'prepare' | 'activate' | 'verify';
    cursor?: TenantPlacementLookupCutoverCursor | null;
    limit?: number;
  },
  dependencies: TenantPlacementLookupCutoverDependencies = {}
): Promise<TenantPlacementLookupCutoverPageResult> {
  if (!SAFE_ID.test(input.tenantId) || input.migration.tenantId !== input.tenantId) {
    throw new Error('tenant_placement_lookup_tenant_invalid');
  }
  const mapping = routeMap(input.migration);
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME;
  if (!environmentId || !SAFE_ID.test(environmentId)) {
    throw new Error('tenant_placement_lookup_environment_invalid');
  }
  if (
    !dependencies.ranges &&
    (!env.TENANT_RUNTIME_REGISTRY || !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS)
  ) {
    throw new Error('tenant_placement_lookup_registry_unavailable');
  }
  const ranges = canonicalRanges(
    dependencies.ranges ??
      (
        await loadVerifiedLookupBucketAssignmentProvider({
          store: env.TENANT_RUNTIME_REGISTRY!,
          environmentId,
          publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS!,
        })
      ).listActiveRanges()
  );
  const rangesDigest = await sha256(JSON.stringify(ranges));
  const cursor = input.cursor ?? { rangesDigest, rangeIndex: 0, rowId: 0 };
  if (
    cursor.rangesDigest !== rangesDigest ||
    !Number.isSafeInteger(cursor.rangeIndex) ||
    cursor.rangeIndex < 0 ||
    cursor.rangeIndex > ranges.length ||
    !Number.isSafeInteger(cursor.rowId) ||
    cursor.rowId < 0
  ) {
    throw new Error('tenant_placement_lookup_cursor_stale');
  }
  const limit = input.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new Error('tenant_placement_lookup_limit_invalid');
  }

  let rangeIndex = cursor.rangeIndex;
  let rowId = cursor.rowId;
  let emptyRangeCount = 0;
  while (rangeIndex < ranges.length) {
    const range = ranges[rangeIndex]!;
    const database = (dependencies.resolveBinding ?? ((ref) => binding(env, ref)))(
      range.bindingRef
    );
    const session = database.withSession('first-primary');
    const page = await session
      .prepare(
        `SELECT rowid AS row_id, virtual_bucket, account_route_generation,
                route_projection_json, tenant_lifecycle_state, runtime_route_status, lifecycle_state
           FROM lookup_identifiers
          WHERE tenant_id = ? AND virtual_bucket BETWEEN ? AND ? AND rowid > ?
          ORDER BY rowid LIMIT ?`
      )
      .bind(input.tenantId, range.startBucket, range.endBucket, rowId, limit)
      .all<LookupRouteRow>();
    if (page.results.length === 0) {
      rangeIndex += 1;
      rowId = 0;
      emptyRangeCount += 1;
      if (rangeIndex < ranges.length && emptyRangeCount >= MAX_EMPTY_RANGES_PER_PAGE) {
        return {
          phase: input.phase,
          processedRows: 0,
          complete: false,
          cursor: { rangesDigest, rangeIndex, rowId },
        };
      }
      continue;
    }

    const expected = page.results.map((row) => {
      const id = positiveInteger(row.row_id, 'tenant_placement_lookup_row_invalid');
      const accountRouteGeneration = positiveInteger(
        row.account_route_generation,
        'tenant_placement_lookup_route_generation_invalid'
      );
      const projection = replaceProjection(row.route_projection_json, mapping);
      if (projection.accountRouteGeneration !== accountRouteGeneration) {
        throw new Error('tenant_placement_lookup_route_generation_mismatch');
      }
      return { id, projection, projectionJson: JSON.stringify(projection) };
    });

    if (input.phase !== 'verify') {
      const statements = expected.map(({ id, projection, projectionJson }) => {
        if (input.phase === 'prepare') {
          return session
            .prepare(
              `UPDATE lookup_identifiers
                  SET required_binding_route_generation = ?, route_projection_json = ?,
                      tenant_lifecycle_state = 'active', runtime_route_status = 'pending',
                      lifecycle_state = 'pending', updated_at = ?
                WHERE rowid = ? AND tenant_id = ? AND account_route_generation = ?
                  AND lifecycle_state IN ('active', 'pending')`
            )
            .bind(
              Math.max(
                ...projection.targets.map((target) => target.requiredBindingRouteGeneration)
              ),
              projectionJson,
              Math.floor(Date.now() / 1000),
              id,
              input.tenantId,
              projection.accountRouteGeneration
            );
        }
        return session
          .prepare(
            `UPDATE lookup_identifiers
                SET tenant_lifecycle_state = 'active', runtime_route_status = 'active',
                    lifecycle_state = 'active', updated_at = ?
              WHERE rowid = ? AND tenant_id = ? AND account_route_generation = ?
                AND route_projection_json = ? AND lifecycle_state IN ('pending', 'active')`
          )
          .bind(
            Math.floor(Date.now() / 1000),
            id,
            input.tenantId,
            projection.accountRouteGeneration,
            projectionJson
          );
      });
      const results = await session.batch(statements);
      if (
        results.length !== statements.length ||
        results.some((result) => !result.success || Number(result.meta.changes) !== 1)
      ) {
        throw new Error('tenant_placement_lookup_write_failed');
      }
    }

    const reflected = await reflectedRows(
      session,
      expected.map(({ id }) => id)
    );
    if (reflected.length !== expected.length) {
      throw new Error('tenant_placement_lookup_reflection_failed');
    }
    for (let index = 0; index < reflected.length; index += 1) {
      const row = reflected[index]!;
      const target = expected[index]!;
      const expectedState = input.phase === 'prepare' ? 'pending' : 'active';
      const expectedRuntime = input.phase === 'prepare' ? 'pending' : 'active';
      if (
        positiveInteger(row.row_id, 'tenant_placement_lookup_row_invalid') !== target.id ||
        row.route_projection_json !== target.projectionJson ||
        row.tenant_lifecycle_state !== 'active' ||
        row.runtime_route_status !== expectedRuntime ||
        row.lifecycle_state !== expectedState
      ) {
        throw new Error('tenant_placement_lookup_reflection_failed');
      }
    }

    const lastRowId = expected.at(-1)!.id;
    const completeRange = page.results.length < limit;
    const nextRangeIndex = completeRange ? rangeIndex + 1 : rangeIndex;
    const nextRowId = completeRange ? 0 : lastRowId;
    return {
      phase: input.phase,
      processedRows: expected.length,
      complete: nextRangeIndex >= ranges.length,
      cursor:
        nextRangeIndex >= ranges.length
          ? null
          : { rangesDigest, rangeIndex: nextRangeIndex, rowId: nextRowId },
    };
  }

  return { phase: input.phase, processedRows: 0, complete: true, cursor: null };
}
