import type { D1Database } from '@cloudflare/workers-types';
import type { D1ConsistencyRequest, TenantRouteDataRole } from '../control-plane';
import { createD1ConsistencyRequest } from '../control-plane';
import {
  lookupBlindIndexCacheKeyDigest,
  type LookupAliasIndex,
  type LookupBlindIndex,
} from './blind-index';
import {
  LookupDirectoryRepository,
  mergeRotatingLookupMemberships,
  type ResolvedLookupAlias,
  type ResolvedLookupMembership,
} from './repository';

const DEFAULT_MEMORY_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_MEMORY_CACHE_ENTRIES = 10_000;
const SAFE_BINDING_REF = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface ActiveLookupBucketAssignment {
  virtualBucket: number;
  assignmentGeneration: number;
  lookupShardId: string;
  bindingRef: string;
  state: 'active';
}

export interface LookupBucketAssignmentProvider {
  resolveActiveAssignment(virtualBucket: number): Promise<ActiveLookupBucketAssignment>;
}

export type LookupRouteRequestCache = Map<string, readonly ResolvedLookupMembership[]>;

export interface LookupRouteResolverEnv {
  [bindingRef: string]: unknown;
}

export interface ResolvedLookupTarget {
  membership: ResolvedLookupMembership;
  dataRole: TenantRouteDataRole;
  residencyPartition: string;
  shardId: string;
  bindingRef: string;
  requiredBindingRouteGeneration: number;
  source: D1Database;
}

interface MemoryCacheEntry {
  memberships: readonly ResolvedLookupMembership[];
  expiresAt: number;
}

interface AliasMemoryCacheEntry {
  aliases: readonly ResolvedLookupAlias[];
  expiresAt: number;
}

const memoryCache = new Map<string, MemoryCacheEntry>();
const aliasMemoryCache = new Map<string, AliasMemoryCacheEntry>();

function cloneMemberships(
  memberships: readonly ResolvedLookupMembership[]
): ResolvedLookupMembership[] {
  return memberships.map((membership) => ({
    ...membership,
    routeProjection: {
      ...membership.routeProjection,
      targets: membership.routeProjection.targets.map((target) => ({ ...target })),
    },
  }));
}

function strictAssignment(
  value: ActiveLookupBucketAssignment,
  expectedBucket: number
): ActiveLookupBucketAssignment {
  if (
    !value ||
    value.state !== 'active' ||
    value.virtualBucket !== expectedBucket ||
    !Number.isSafeInteger(value.assignmentGeneration) ||
    value.assignmentGeneration < 1 ||
    typeof value.lookupShardId !== 'string' ||
    value.lookupShardId.length < 1 ||
    value.lookupShardId.length > 256 ||
    !SAFE_BINDING_REF.test(value.bindingRef)
  ) {
    throw new Error('lookup_bucket_assignment_invalid');
  }
  return value;
}

function isSessionCapableD1(value: unknown): value is D1Database {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<D1Database>;
  return (
    typeof candidate.prepare === 'function' &&
    typeof candidate.batch === 'function' &&
    typeof candidate.withSession === 'function'
  );
}

function pruneMemoryCache(now: number): void {
  for (const [key, value] of memoryCache) {
    if (value.expiresAt <= now) memoryCache.delete(key);
  }
  while (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldest = memoryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

function pruneAliasMemoryCache(now: number): void {
  for (const [key, value] of aliasMemoryCache) {
    if (value.expiresAt <= now) aliasMemoryCache.delete(key);
  }
  while (aliasMemoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const oldest = aliasMemoryCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    aliasMemoryCache.delete(oldest);
  }
}

export function clearLookupRouteMemoryCache(): void {
  memoryCache.clear();
  aliasMemoryCache.clear();
}

async function routeCacheKey(
  index: LookupBlindIndex,
  assignment: ActiveLookupBucketAssignment
): Promise<string> {
  return [
    index.indexKind,
    index.normalizationVersion,
    index.hmacKeyGeneration,
    await lookupBlindIndexCacheKeyDigest(index),
    assignment.assignmentGeneration,
    assignment.lookupShardId,
  ].join(':');
}

function aliasCacheKey(index: LookupAliasIndex, assignment: ActiveLookupBucketAssignment): string {
  return [
    'alias',
    index.aliasKind,
    index.digest,
    assignment.assignmentGeneration,
    assignment.lookupShardId,
  ].join(':');
}

function cloneAliases(aliases: readonly ResolvedLookupAlias[]): ResolvedLookupAlias[] {
  return aliases.map((alias) => ({
    ...alias,
    routeProjection: {
      ...alias.routeProjection,
      target: { ...alias.routeProjection.target },
    },
  }));
}

export class LookupRouteResolver {
  private readonly now: () => number;
  private readonly memoryCacheTtlMs: number;

  constructor(
    private readonly env: LookupRouteResolverEnv,
    private readonly assignments: LookupBucketAssignmentProvider,
    options: { now?: () => number; memoryCacheTtlMs?: number } = {}
  ) {
    this.now = options.now ?? (() => Date.now());
    this.memoryCacheTtlMs = Math.min(
      DEFAULT_MEMORY_CACHE_TTL_MS,
      Math.max(1, options.memoryCacheTtlMs ?? DEFAULT_MEMORY_CACHE_TTL_MS)
    );
  }

  async resolveMemberships(input: {
    indexes: readonly LookupBlindIndex[];
    requestCache?: LookupRouteRequestCache;
    consistency?: D1ConsistencyRequest;
  }): Promise<ResolvedLookupMembership[]> {
    if (input.indexes.length < 1 || input.indexes.length > 2) {
      throw new Error('lookup_route_index_count_invalid');
    }
    const identity = new Set(
      input.indexes.map(
        (index) =>
          `${index.indexKind}:${index.normalizationVersion}:${index.hmacKeyGeneration}:${index.digest}`
      )
    );
    if (identity.size !== input.indexes.length) throw new Error('lookup_route_index_duplicate');

    const resultSets = await Promise.all(
      input.indexes.map(async (index) => {
        const assignment = strictAssignment(
          await this.assignments.resolveActiveAssignment(index.virtualBucket),
          index.virtualBucket
        );
        const cacheKey = await routeCacheKey(index, assignment);
        const requestCached = input.requestCache?.get(cacheKey);
        if (requestCached) return cloneMemberships(requestCached);

        const now = this.now();
        const memoryCached = memoryCache.get(cacheKey);
        if (memoryCached && memoryCached.expiresAt > now) {
          memoryCache.delete(cacheKey);
          memoryCache.set(cacheKey, memoryCached);
          const memberships = cloneMemberships(memoryCached.memberships);
          input.requestCache?.set(cacheKey, memberships);
          return memberships;
        }
        if (memoryCached) memoryCache.delete(cacheKey);

        const binding = this.env[assignment.bindingRef];
        if (!isSessionCapableD1(binding)) throw new Error('lookup_physical_binding_unavailable');
        const result = await new LookupDirectoryRepository(binding).findActiveMemberships(
          index,
          input.consistency ?? createD1ConsistencyRequest('replica_eligible')
        );
        const memberships = cloneMemberships(result.memberships);
        input.requestCache?.set(cacheKey, memberships);
        if (memberships.length > 0) {
          pruneMemoryCache(now);
          memoryCache.set(cacheKey, {
            memberships: cloneMemberships(memberships),
            expiresAt: now + this.memoryCacheTtlMs,
          });
        }
        return memberships;
      })
    );
    return mergeRotatingLookupMemberships(resultSets);
  }

  async resolveAlias(input: {
    index: LookupAliasIndex;
    consistency?: D1ConsistencyRequest;
  }): Promise<ResolvedLookupAlias | null> {
    const assignment = strictAssignment(
      await this.assignments.resolveActiveAssignment(input.index.virtualBucket),
      input.index.virtualBucket
    );
    const cacheKey = aliasCacheKey(input.index, assignment);
    const now = this.now();
    const cached = aliasMemoryCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      aliasMemoryCache.delete(cacheKey);
      aliasMemoryCache.set(cacheKey, cached);
      return cloneAliases(cached.aliases)[0] ?? null;
    }
    if (cached) aliasMemoryCache.delete(cacheKey);

    const binding = this.env[assignment.bindingRef];
    if (!isSessionCapableD1(binding)) throw new Error('lookup_physical_binding_unavailable');
    const result = await new LookupDirectoryRepository(binding).findActiveAlias(
      input.index,
      input.consistency ?? createD1ConsistencyRequest('replica_eligible')
    );
    const aliases = cloneAliases(result.aliases);
    if (aliases.length > 0) {
      pruneAliasMemoryCache(now);
      aliasMemoryCache.set(cacheKey, {
        aliases: cloneAliases(aliases),
        expiresAt: now + this.memoryCacheTtlMs,
      });
    }
    return aliases[0] ?? null;
  }

  resolveTarget(input: {
    membership: ResolvedLookupMembership;
    dataRole: TenantRouteDataRole;
    residencyPartition: string;
    observedBindingRouteGenerations: Readonly<Record<string, number>>;
  }): ResolvedLookupTarget {
    const targets = input.membership.routeProjection.targets.filter(
      (target) =>
        target.dataRole === input.dataRole && target.residencyPartition === input.residencyPartition
    );
    if (targets.length !== 1) throw new Error('lookup_route_target_not_unique');
    const target = targets[0];
    if (!SAFE_BINDING_REF.test(target.bindingRef)) throw new Error('lookup_route_binding_invalid');
    const observedGeneration = input.observedBindingRouteGenerations[target.bindingRef];
    if (
      !Number.isSafeInteger(observedGeneration) ||
      observedGeneration < target.requiredBindingRouteGeneration
    ) {
      throw new Error('lookup_route_binding_generation_stale');
    }
    const binding = this.env[target.bindingRef];
    if (!isSessionCapableD1(binding)) throw new Error('lookup_route_binding_unavailable');
    return {
      membership: cloneMemberships([input.membership])[0],
      dataRole: target.dataRole,
      residencyPartition: target.residencyPartition,
      shardId: target.shardId,
      bindingRef: target.bindingRef,
      requiredBindingRouteGeneration: target.requiredBindingRouteGeneration,
      source: binding,
    };
  }

  async resolveTargetAndRevalidate(input: {
    membership: ResolvedLookupMembership;
    dataRole: TenantRouteDataRole;
    residencyPartition: string;
    observedBindingRouteGenerations: Readonly<Record<string, number>>;
    verifyAtDestination(target: ResolvedLookupTarget): Promise<boolean>;
  }): Promise<ResolvedLookupTarget> {
    const target = this.resolveTarget(input);
    if (!(await input.verifyAtDestination(target))) {
      throw new Error('lookup_destination_revalidation_failed');
    }
    return target;
  }
}
