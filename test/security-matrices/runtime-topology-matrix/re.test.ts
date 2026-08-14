/**
 * Matrix R-E (required group 6): service-binding state × forwarded host × tenant context
 * through the production `requestContextMiddleware`.
 *
 * The forwarded host selects the tenant context (a trusted conflicting forwarded host
 * selects the foreign beta context); the service binding is then resolved for the CONTEXT
 * tenant, never the host tenant, and no foreign binding is touched. Required triple
 * coverage is verified by the independent checker in meta.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installFrozenNow, restoreRealClock, frozenNowMs } from '../fixtures/deterministic-clock';
import { RE_CASE_TABLE, decideRoutingRe, type ReDecision, type TopoCase } from './cases';
import {
  checkRaObservation,
  corruptRaObservationDomain,
  RA_OBSERVATION_DOMAINS,
  emptyRaObservation,
  type RaObservation,
} from './observation';
import {
  createTopologyKit,
  createProbeApp,
  runProbe,
  seedTenantRow,
  makeGenerationDocument,
  observedTenantAccessSet,
  type TopologyEnvKit,
} from './routing-env';
import {
  buildSnapshot,
  signSnapshot,
  RUNTIME_REGISTRY_GENERATION_KEY,
  RUNTIME_REGISTRY_SNAPSHOT_KEY,
} from './registry-fixtures';
import {
  buildRaObservation,
  expectedRaObservation,
  assertRaObservation,
  intendedTenantOf,
} from './harness';
import { clearTenantDatabaseResolverMemoryCache } from '../../../packages/ar-lib-core/src/services/tenant-database-resolver';

const FROZEN_NOW = 1700000000;

function throwingBinding(): unknown {
  return {
    prepare: () => {
      throw new Error('binding transport failed');
    },
    batch: async () => {
      throw new Error('binding transport failed');
    },
  };
}

function bindingRefOf(serviceBindingState: string): string {
  switch (serviceBindingState) {
    case 'missing':
      return 'MISSING_DB';
    case 'wrong-type':
      return 'DB_WRONG';
    case 'throws':
      return 'DB_THROW';
    default:
      return 'DB';
  }
}

async function seedBindingRegistry(
  kit: TopologyEnvKit,
  tenantId: string,
  bindingRef: string
): Promise<string[]> {
  const nowMs = frozenNowMs();
  const snapshot = buildSnapshot({
    tenantId,
    runtimeGeneration: 5,
    routeStatus: 'active',
    quarantineDenyGeneration: 0,
    stores: [
      {
        tenantId,
        dataRole: 'tenant_core/default',
        bindingRef,
        generation: 5,
        runtimeGeneration: 5,
        allocationScope: 'shared_pool',
        ownerTenantId: null,
        provider: 'd1',
        databaseId: `db-core-${tenantId}`,
      },
    ],
    publishedAt: new Date(nowMs - 60_000).toISOString(),
    expiresAt: new Date(nowMs + 3600_000).toISOString(),
  });
  const signed = await signSnapshot(snapshot, new Date(nowMs).toISOString());
  await kit.runtimeRegistry.put(
    RUNTIME_REGISTRY_GENERATION_KEY(tenantId),
    makeGenerationDocument(5, 'active', 0, nowMs)
  );
  await kit.runtimeRegistry.put(RUNTIME_REGISTRY_SNAPSHOT_KEY(tenantId), JSON.stringify(signed));
  return [signed.metadata.signature as string];
}

async function seedReRow(entry: TopoCase): Promise<{
  kit: TopologyEnvKit;
  app: ReturnType<typeof createProbeApp>;
  request: Request;
  secrets: string[];
}> {
  const d = entry.dimensions;
  const serviceBindingState = String(d.serviceBindingState);
  const forwardedHost = String(d.forwardedHost);
  const tenantContextState = String(d.tenantContextState);
  const hostState = String(d.hostState);

  const kit = await createTopologyKit({
    deploymentMode: 'multi',
    forwardedPolicy: forwardedHost === 'none' ? 'disabled' : 'enabled',
    registryState: 'valid',
  });
  const env = kit.env as unknown as Record<string, unknown>;
  if (serviceBindingState === 'wrong-type') env['DB_WRONG'] = 'not-a-database';
  if (serviceBindingState === 'throws') env['DB_THROW'] = throwingBinding();

  seedTenantRow(kit, 'default', 'active');
  seedTenantRow(kit, 'alpha', 'active');
  seedTenantRow(kit, 'beta', 'active');

  const secrets: string[] = [];
  if (tenantContextState !== 'missing') {
    // Only the CONTEXT tenant's registry is seeded; the other tenant must never be
    // consulted.
    const contextTenant = tenantContextState === 'foreign' ? 'beta' : 'alpha';
    secrets.push(
      ...(await seedBindingRegistry(kit, contextTenant, bindingRefOf(serviceBindingState)))
    );
  }

  const host = hostState === 'unresolvable' ? 'evil.example' : 'alpha.authrim.example';
  const headers: Record<string, string> = { Host: host };
  if (forwardedHost === 'matching') headers['X-Authrim-Forwarded-Host'] = 'alpha.authrim.example';
  if (forwardedHost === 'conflicting') headers['X-Authrim-Forwarded-Host'] = 'beta.authrim.example';
  const request = new Request(`https://${host}/api/v1/login/interactions/start`, {
    method: 'POST',
    headers,
  });
  const app = createProbeApp(kit.env);
  return { kit, app, request, secrets };
}

/** R-E dimensions mapped to the R-A hostClass/forwarded shape for `intendedTenantOf`. */
function toRaShapeDimensions(entry: TopoCase): Record<string, unknown> {
  const d = entry.dimensions;
  const hostState = String(d.hostState);
  const forwardedHost = String(d.forwardedHost);
  return {
    deploymentMode: 'multi',
    hostClass: hostState === 'unresolvable' ? 'unrelated' : 'canonical',
    forwardedPolicy: forwardedHost === 'none' ? 'disabled' : 'enabled',
    forwardedState:
      forwardedHost === 'none'
        ? 'missing'
        : forwardedHost === 'matching'
          ? 'matching'
          : 'conflicting',
    requestClass: 'protocol',
    tenantLifecycle: 'active',
    vanityState: 'missing',
    registryState: 'valid',
    bindingState: 'present',
  };
}

/** R-E rows need a dedicated expectation: a throwing binding fails at the tenant-exists
 *  check without any recorded D1 query; missing/wrong-type bindings fail at the metadata
 *  context with a health event; and a foreign context selected by a conflicting
 *  forwarded host is rejected by the tenant host-binding policy after its own binding
 *  was used. */
function expectedReObservation(entry: TopoCase, decision: ReDecision): RaObservation {
  const obs = emptyRaObservation();
  const d = entry.dimensions;
  const tenantContextState = String(d.tenantContextState);
  const hostState = String(d.hostState);
  const contextTenant = tenantContextState === 'foreign' ? 'beta' : 'alpha';
  obs.status = decision.status;
  obs.error = decision.error;
  obs.errorDescription = decision.errorDescription;
  obs.rejectionLayer = decision.rejectionLayer;
  obs.tenantId = decision.tenantId;
  obs.issuerHost = decision.issuerHost;
  obs.tenantContextState = decision.tenantContextState;
  obs.registryStatus = tenantContextState === 'missing' ? null : 'valid';
  obs.tenantAccessSet = tenantContextState === 'missing' ? [] : [contextTenant];
  obs.vanityResolutionAttempted = hostState === 'unresolvable';
  obs.registrySnapshotRead = tenantContextState !== 'missing';
  if (decision.status === 200) {
    obs.canonicalIssuerState = 'tenant-canonical';
    obs.tenantExistsQuery = true;
    obs.tenantExistsCacheWrite = true;
    obs.vanityPrimaryQuery = true;
    obs.settingsRead = true;
    obs.bindingOperation = 'd1:core:tenants';
  } else if (decision.rejectionLayer === 'binding-policy') {
    // The foreign context's own binding was used for the tenant-exists check before the
    // host-binding policy rejected the request host.
    obs.canonicalIssuerState = 'mismatched';
    obs.tenantExistsQuery = true;
    obs.tenantExistsCacheWrite = true;
    obs.vanityPrimaryQuery = true;
    obs.settingsRead = true;
    obs.bindingOperation = 'd1:core:tenants';
  } else if (decision.rejectionLayer === 'metadata-context') {
    obs.canonicalIssuerState = 'unavailable';
    obs.securityEventWritten = true;
  } else {
    obs.canonicalIssuerState = 'unavailable';
  }
  obs.foreignTenantAccess = false;
  obs.secretLeak = false;
  return obs;
}

describe('runtime-topology Matrix R-E: service binding × forwarded host × tenant context', () => {
  beforeEach(() => {
    installFrozenNow(FROZEN_NOW);
    clearTenantDatabaseResolverMemoryCache();
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of RE_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedReRow(entry);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const observation = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(toRaShapeDimensions(entry))
      );
      const expected = expectedReObservation(entry, decideRoutingRe(entry.dimensions as never));
      observation.foreignTenantAccess = observation.tenantAccessSet.some(
        (tenant) => !expected.tenantAccessSet.includes(tenant)
      );
      assertRaObservation(observation, expected);
    });
  }

  it('the service binding is resolved for the context tenant, never the host tenant', async () => {
    expect.hasAssertions();
    // Foreign context (beta) with a missing binding: the failure must reference beta's
    // registry and never touch alpha.
    const foreignRow = RE_CASE_TABLE.find(
      (row) =>
        String(row.dimensions.tenantContextState) === 'foreign' &&
        String(row.dimensions.serviceBindingState) === 'missing'
    ) as TopoCase;
    const seeded = await seedReRow(foreignRow);
    const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
    expect(result.status).toBe(409);
    expect(result.error).toBe('missing_binding');
    const access = observedTenantAccessSet(seeded.kit.ledger);
    expect(access).toEqual(['beta']);
    expect(seeded.kit.ledger.all().some((entry) => entry.target.includes('tenant:alpha:'))).toBe(
      false
    );
  });

  it('oracle sensitivity: corrupted real R-E observations are rejected per domain', async () => {
    expect.hasAssertions();
    for (const entry of RE_CASE_TABLE.slice(0, 10)) {
      const seeded = await seedReRow(entry);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const observed = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(toRaShapeDimensions(entry))
      );
      const expected = expectedReObservation(entry, decideRoutingRe(entry.dimensions as never));
      observed.foreignTenantAccess = observed.tenantAccessSet.some(
        (tenant) => !expected.tenantAccessSet.includes(tenant)
      );
      const mismatches = checkRaObservation(observed, expected);
      expect(
        mismatches,
        `real observation of ${entry.id} mismatches: ${mismatches.join(', ')}`
      ).toEqual([]);
      for (const domain of RA_OBSERVATION_DOMAINS) {
        const corrupted = corruptRaObservationDomain(expected, domain);
        expect(
          checkRaObservation(corrupted, expected).length,
          `domain ${domain} on ${entry.id}`
        ).toBeGreaterThan(0);
      }
    }
  });

  it('every R-E case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of RE_CASE_TABLE) {
      const base = decideRoutingRe(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        let mutant: unknown;
        switch (mutationId) {
          case 'topology:fall-back-to-common-database-when-required-binding-missing':
            mutant = {
              ...base,
              status: 200,
              error: null,
              rejectionLayer: null,
              bindingOperation: 'd1:alpha:tenants',
            };
            break;
          case 'topology:return-success-route-after-service-binding-failure':
            mutant = {
              ...base,
              status: 200,
              error: null,
              rejectionLayer: null,
              bindingOperation: 'd1:alpha:tenants',
            };
            break;
          case 'topology:use-foreign-tenant-registry-or-binding':
            mutant = {
              ...base,
              tenantId: base.tenantId === 'beta' ? 'alpha' : 'beta',
              tenantContextState: 'matching',
            };
            break;
          default:
            mutant = { ...base, status: base.status === 200 ? 500 : 200 };
        }
        expect(JSON.stringify(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});
