/**
 * Matrix R-C (required group 3): route status × cache state × runtime generation through
 * the production `resolveTenantDatabaseSourceFromRegistry`.
 *
 * The generation document carries the route status; a non-active route throws
 * `quarantined_route` in assertRuntimeRouteAvailable before any cache or
 * generation-vs-snapshot check. Warm / warm-stale cache shapes are driven with the
 * request cache exactly like Matrix R-B.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installFrozenNow, restoreRealClock, frozenNowMs } from '../fixtures/deterministic-clock';
import { RC_CASE_TABLE, decideRoutingRc, type RbDecision, type TopoCase } from './cases';
import {
  checkRbObservation,
  corruptRbObservationDomain,
  RB_OBSERVATION_DOMAINS,
  emptyRbObservation,
  type RbObservation,
} from './observation';
import {
  createTopologyKit,
  makeGenerationDocument,
  observedTenantAccessSet,
  observedBindingOperation,
  type TopologyEnvKit,
} from './routing-env';
import {
  buildSnapshot,
  signSnapshot,
  RUNTIME_REGISTRY_GENERATION_KEY,
  RUNTIME_REGISTRY_SNAPSHOT_KEY,
} from './registry-fixtures';
import {
  clearTenantDatabaseResolverMemoryCache,
  resolveTenantDatabaseSourceFromRegistry,
  type ResolvedTenantDatabaseSource,
  type TenantDatabaseRequestCache,
} from '../../../packages/ar-lib-core/src/services/tenant-database-resolver';

const FROZEN_NOW = 1700000000;

interface RcRunResult {
  resolved?: ResolvedTenantDatabaseSource;
  error?: unknown;
}

async function seedRcRow(entry: TopoCase): Promise<{
  kit: TopologyEnvKit;
  requestCache: TenantDatabaseRequestCache;
  run: () => Promise<RcRunResult>;
  resolveOnce: () => Promise<RcRunResult>;
  cacheHit: boolean;
}> {
  const d = entry.dimensions;
  const routeStatus = String(d.routeStatus);
  const cacheState = String(d.cacheState);
  const runtimeGeneration = String(d.runtimeGeneration);

  const kit = await createTopologyKit({
    deploymentMode: 'multi',
    forwardedPolicy: 'disabled',
    registryState: 'valid',
  });
  const nowMs = frozenNowMs();
  const snapshot = buildSnapshot({
    tenantId: 'alpha',
    runtimeGeneration: 5,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    stores: [
      {
        tenantId: 'alpha',
        dataRole: 'tenant_core/default',
        bindingRef: 'DB',
        generation: 5,
        runtimeGeneration: 5,
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        provider: 'd1',
        databaseId: 'db-alpha-core-default',
      },
    ],
    publishedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 3600_000).toISOString(),
  });
  const signed = await signSnapshot(snapshot, new Date(nowMs).toISOString());
  await kit.runtimeRegistry.put(RUNTIME_REGISTRY_SNAPSHOT_KEY('alpha'), JSON.stringify(signed));

  // The warm-stale shape starts at generation 5 (matching) and advances to 6 between
  // the two calls; cold rows with 'ahead' observe the mismatch directly.
  const generationRuntimeGeneration =
    runtimeGeneration === 'stale'
      ? 4
      : runtimeGeneration === 'ahead'
        ? cacheState === 'warm-stale'
          ? 5
          : 6
        : 5;
  if (runtimeGeneration !== 'missing') {
    const generation = makeGenerationDocument(
      generationRuntimeGeneration,
      routeStatus as 'active' | 'quarantining' | 'quarantined' | 'disabled',
      routeStatus === 'active' ? 0 : 1,
      nowMs
    );
    await kit.runtimeRegistry.put(RUNTIME_REGISTRY_GENERATION_KEY('alpha'), generation);
  }

  const requestCache: TenantDatabaseRequestCache = new Map();
  const resolveOnce = async (): Promise<RcRunResult> => {
    try {
      const resolved = await resolveTenantDatabaseSourceFromRegistry(kit.env, {
        tenantId: 'alpha',
        role: 'tenant_core',
        dataRole: 'tenant_core/default',
        shardGroup: 'default',
        shardIndex: 0,
        requestCache,
        memoryCacheTtlMs: 0,
        generationCacheTtlMs: 0,
      });
      return { resolved };
    } catch (error) {
      return { error };
    }
  };

  const reseedGenerationSix = async (): Promise<void> => {
    const next = buildSnapshot({
      tenantId: 'alpha',
      runtimeGeneration: 6,
      routeStatus: 'active',
      quarantineDenyGeneration: 0,
      stores: [
        {
          tenantId: 'alpha',
          dataRole: 'tenant_core/default',
          bindingRef: 'DB',
          generation: 6,
          runtimeGeneration: 6,
          allocationScope: 'shared_pool',
          ownerTenantId: null,
          provider: 'd1',
          databaseId: 'db-alpha-core-default',
        },
      ],
      publishedAt: new Date(nowMs - 30_000).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    });
    const signedNext = await signSnapshot(next, new Date(nowMs).toISOString());
    await kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_GENERATION_KEY('alpha'),
      makeGenerationDocument(6, 'active', 0, nowMs)
    );
    await kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_SNAPSHOT_KEY('alpha'),
      JSON.stringify(signedNext)
    );
  };

  const run = async (): Promise<RcRunResult> => {
    if (cacheState === 'warm' || cacheState === 'warm-stale') {
      const first = await resolveOnce();
      if (first.error) {
        throw new Error(`warm row ${entry.id}: first resolution failed: ${String(first.error)}`);
      }
      if (cacheState === 'warm-stale') {
        await reseedGenerationSix();
      }
    }
    const result = await resolveOnce();
    if (result.resolved) {
      // Exercise the selected binding so the actual binding operation is observed.
      try {
        await (
          result.resolved.source as unknown as { queryOne(sql: string): Promise<unknown> }
        ).queryOne('SELECT 1');
      } catch (error) {
        return { error };
      }
    }
    return result;
  };

  const cacheHit = cacheState === 'warm';
  return { kit, requestCache, run, resolveOnce, cacheHit };
}

function deriveRcErrorCode(error: unknown): string | null {
  return error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

async function buildRcObservation(
  kit: TopologyEnvKit,
  result: RcRunResult,
  cacheHit: boolean
): Promise<RbObservation> {
  const obs = emptyRbObservation();
  if (result.error) {
    obs.outcome = 'error';
    obs.errorCode = deriveRcErrorCode(result.error);
    switch (obs.errorCode) {
      case 'quarantined_route':
        obs.rejectionLayer = 'route';
        break;
      case 'missing_generation':
        obs.rejectionLayer = 'generation';
        break;
      case 'invalid_snapshot_signature':
        obs.rejectionLayer = 'generation';
        break;
      default:
        break;
    }
  } else if (result.resolved) {
    obs.outcome = 'resolved';
    obs.bindingRef = result.resolved.bindingRef;
    obs.generation = result.resolved.generation;
    obs.runtimeGeneration = result.resolved.runtimeGeneration;
    obs.dataRole = result.resolved.dataRole;
    obs.allocationScope = result.resolved.allocationScope;
    obs.ownerTenantId = result.resolved.ownerTenantId;
    obs.provider = result.resolved.driver;
  }
  obs.cacheHit = cacheHit;
  obs.tenantAccessSet = observedTenantAccessSet(kit.ledger);
  obs.bindingOperation =
    obs.outcome === 'resolved' ? (observedBindingOperation(kit.ledger, 'SELECT 1') ?? null) : null;
  return obs;
}

function expectedRcObservation(entry: TopoCase, decision: RbDecision): RbObservation {
  const obs = emptyRbObservation();
  obs.outcome = decision.outcome;
  obs.errorCode = decision.errorCode;
  obs.rejectionLayer = decision.rejectionLayer;
  obs.bindingRef = decision.bindingRef;
  obs.generation = decision.generation;
  obs.runtimeGeneration = decision.runtimeGeneration;
  obs.dataRole = decision.dataRole;
  obs.allocationScope = decision.allocationScope;
  obs.ownerTenantId = decision.ownerTenantId;
  obs.provider = decision.provider;
  obs.cacheHit = decision.cacheHit;
  obs.securityEventWritten = false;
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  obs.tenantAccessSet = ['alpha'];
  obs.bindingOperation = decision.outcome === 'resolved' ? 'd1:core:SELECT 1' : null;
  return obs;
}

function assertRcObservation(observation: RbObservation, expected: RbObservation): void {
  const mismatches = checkRbObservation(observation, expected);
  expect(
    mismatches,
    `observation mismatches: ${mismatches.join(', ')}\nOBS=${JSON.stringify(observation)}\nEXP=${JSON.stringify(expected)}`
  ).toEqual([]);
}

function rcMutationCandidate(entry: TopoCase, mutationId: string): RbDecision {
  const base = decideRoutingRc(entry.dimensions as never);
  const resolvedShape = {
    ...base,
    outcome: 'resolved' as const,
    errorCode: null,
    rejectionLayer: null,
    bindingRef: 'DB',
  };
  switch (mutationId) {
    case 'topology:use-quarantined-route-as-active':
      return { ...resolvedShape, generation: 5, runtimeGeneration: 5 };
    case 'topology:reuse-stale-runtime-generation-cache':
      return base.outcome === 'resolved'
        ? { ...base, generation: 4, runtimeGeneration: 4, cacheHit: true }
        : { ...resolvedShape, generation: 5, runtimeGeneration: 5 };
    default:
      throw new Error(`Unknown R-C mutation ${mutationId}`);
  }
}

describe('runtime-topology Matrix R-C: route status × cache × runtime generation', () => {
  beforeEach(() => {
    installFrozenNow(FROZEN_NOW);
    clearTenantDatabaseResolverMemoryCache();
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of RC_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedRcRow(entry);
      const result = await seeded.run();
      const observation = await buildRcObservation(seeded.kit, result, seeded.cacheHit);
      if (observation.outcome === 'error') {
        expect(seeded.requestCache.size).toBe(0);
      }
      const expected = expectedRcObservation(entry, decideRoutingRc(entry.dimensions as never));
      assertRcObservation(observation, expected);
    });
  }

  it('oracle sensitivity: corrupted real R-C observations are rejected per domain', async () => {
    expect.hasAssertions();
    const representatives = RC_CASE_TABLE.filter((entry) => {
      const decision = decideRoutingRc(entry.dimensions as never);
      return (
        decision.outcome === 'resolved' ||
        decision.rejectionLayer === 'route' ||
        decision.rejectionLayer === 'generation'
      );
    });
    for (const entry of representatives) {
      const seeded = await seedRcRow(entry);
      const result = await seeded.run();
      const observed = await buildRcObservation(seeded.kit, result, seeded.cacheHit);
      const expected = expectedRcObservation(entry, decideRoutingRc(entry.dimensions as never));
      const mismatches = checkRbObservation(observed, expected);
      expect(
        mismatches,
        `real observation of ${entry.id} mismatches: ${mismatches.join(', ')}`
      ).toEqual([]);
      for (const domain of RB_OBSERVATION_DOMAINS) {
        const corrupted = corruptRbObservationDomain(expected, domain);
        expect(
          checkRbObservation(corrupted, expected).length,
          `domain ${domain} on ${entry.id}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every R-C case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of RC_CASE_TABLE) {
      const base = decideRoutingRc(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = rcMutationCandidate(entry, mutationId);
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });

  it('a quarantined route is never served from a warm cache', async () => {
    expect.hasAssertions();
    // A route that becomes quarantined after a successful warm resolution must fail
    // closed on the next call: the route check precedes the cache check.
    const entry = RC_CASE_TABLE.find(
      (row) => String(row.dimensions.cacheState) === 'warm'
    ) as TopoCase;
    const seeded = await seedRcRow(entry);
    const first = await seeded.run();
    expect(first.error).toBeUndefined();
    expect(first.resolved?.runtimeGeneration).toBe(5);
    await seeded.kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_GENERATION_KEY('alpha'),
      makeGenerationDocument(5, 'quarantined', 1, frozenNowMs())
    );
    const second = await seeded.resolveOnce();
    expect(second.error).toBeDefined();
    expect(deriveRcErrorCode(second.error)).toBe('quarantined_route');
  });
});
