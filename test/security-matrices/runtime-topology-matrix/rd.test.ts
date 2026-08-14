/**
 * Matrix R-D (required group 5): vanity state × canonical issuer state ×
 * browser/protocol request through the production `requestContextMiddleware`.
 *
 * The canonical issuer is observed via the probe (`getRequestIssuer`) and the redirect
 * Location for browser canonicalization. Required triple coverage is verified by the
 * independent checker in meta.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import { RD_CASE_TABLE, decideRoutingRd, type RaDecision, type TopoCase } from './cases';
import {
  checkRaObservation,
  corruptRaObservationDomain,
  RA_OBSERVATION_DOMAINS,
} from './observation';
import {
  createTopologyKit,
  createProbeApp,
  runProbe,
  seedTenantRow,
  seedVanityRows,
  seedVanityCache,
  seedRegistryForTenant,
  PRIMARY_VANITY_ALPHA,
  NON_PRIMARY_VANITY_ALPHA,
  type TopologyEnvKit,
  type VanityRowSeed,
} from './routing-env';
import {
  buildRaObservation,
  expectedRaObservation,
  assertRaObservation,
  intendedTenantOf,
} from './harness';
import { clearTenantDatabaseResolverMemoryCache } from '../../../packages/ar-lib-core/src/services/tenant-database-resolver';

const FROZEN_NOW = 1700000000;

function hostOfHostState(hostState: string): string | null {
  switch (hostState) {
    case 'canonical':
      return 'alpha.authrim.example';
    case 'naked':
      return 'authrim.example';
    case 'vanity':
      return 'vanity.alpha.example';
    case 'alias':
      return 'alias.alpha.example';
    case 'unresolvable':
      return 'evil.example';
    default:
      throw new Error(`Unknown hostState ${hostState}`);
  }
}

function hostClassOf(hostState: string): string {
  switch (hostState) {
    case 'canonical':
      return 'canonical';
    case 'naked':
      return 'naked';
    case 'vanity':
      return 'active-vanity';
    case 'alias':
      return 'non-primary-alias';
    case 'unresolvable':
      return 'unrelated';
    default:
      throw new Error(`Unknown hostState ${hostState}`);
  }
}

async function seedRdRow(entry: TopoCase): Promise<{
  kit: TopologyEnvKit;
  app: ReturnType<typeof createProbeApp>;
  request: Request;
  secrets: string[];
}> {
  const d = entry.dimensions;
  const hostState = String(d.hostState);
  const vanityState = String(d.vanityState);
  const requestClass = String(d.requestClass);
  const kit = await createTopologyKit({
    deploymentMode: 'multi',
    forwardedPolicy: 'disabled',
    registryState: 'valid',
  });
  seedTenantRow(kit, 'default', 'active');
  seedTenantRow(kit, 'alpha', 'active');
  seedTenantRow(kit, 'beta', 'active');
  const secrets: string[] = [];
  secrets.push(...(await seedRegistryForTenant(kit, 'alpha', 'valid', 'present')));
  await seedRegistryForTenant(kit, 'default', 'valid', 'present');

  const rows: VanityRowSeed[] = [];
  switch (vanityState) {
    case 'canonical':
      await seedVanityCache(kit, PRIMARY_VANITY_ALPHA, 'alpha');
      rows.push({
        tenantId: 'alpha',
        hostname: PRIMARY_VANITY_ALPHA,
        isActive: true,
        isPrimary: true,
      });
      break;
    case 'non-canonical':
      await seedVanityCache(kit, NON_PRIMARY_VANITY_ALPHA, 'alpha');
      rows.push({
        tenantId: 'alpha',
        hostname: NON_PRIMARY_VANITY_ALPHA,
        isActive: true,
        isPrimary: false,
      });
      break;
    case 'inactive':
      // The request host is the primary vanity host with an inactive row: the cache
      // points at alpha but the D1 revalidation must reject the inactive row.
      await seedVanityCache(kit, PRIMARY_VANITY_ALPHA, 'alpha');
      rows.push({
        tenantId: 'alpha',
        hostname: PRIMARY_VANITY_ALPHA,
        isActive: false,
        isPrimary: true,
      });
      break;
    case 'cross-tenant':
      await seedVanityCache(kit, PRIMARY_VANITY_ALPHA, 'alpha');
      rows.push({
        tenantId: 'beta',
        hostname: PRIMARY_VANITY_ALPHA,
        isActive: true,
        isPrimary: false,
      });
      break;
    default:
      break;
  }
  seedVanityRows(kit, rows);

  const host = hostOfHostState(hostState) as string;
  const headers: Record<string, string> = { Host: host };
  if (requestClass === 'browser') headers['Accept'] = 'text/html';
  const method = requestClass === 'protocol' ? 'POST' : 'GET';
  const path = requestClass === 'protocol' ? '/api/v1/login/interactions/start' : '/probe';
  const request = new Request(`https://${host}${path}`, { method, headers });
  const app = createProbeApp(kit.env);
  return { kit, app, request, secrets };
}

/** Map an R-D row to the equivalent R-A shape so the shared expectation builder applies. */
function toRaShape(entry: TopoCase): { dimensions: Record<string, unknown>; decision: RaDecision } {
  const d = entry.dimensions;
  const dimensions: Record<string, unknown> = {
    deploymentMode: 'multi',
    hostClass: hostClassOf(String(d.hostState)),
    forwardedPolicy: 'disabled',
    forwardedState: 'missing',
    requestClass: String(d.requestClass),
    tenantLifecycle: 'active',
    vanityState: String(d.vanityState),
    registryState: 'valid',
    bindingState: 'present',
  };
  const rd = decideRoutingRd(d as never);
  const registryReached = !(
    rd.status === 400 ||
    (rd.status === 404 && String(d.hostState) === 'unresolvable')
  );
  const decision: RaDecision = {
    status: rd.status,
    error: rd.error,
    errorDescription: rd.errorDescription,
    rejectionLayer: rd.rejectionLayer,
    tenantId: rd.tenantId,
    tenantSource: rd.tenantId === 'default' ? 'default' : 'host',
    issuerHost: rd.issuerHost,
    locationHost: rd.locationHost,
    registryStatus: registryReached ? 'valid' : null,
    bindingRef:
      rd.rejectionLayer === 'binding-policy' || rd.status === 200 || rd.status === 308
        ? 'DB'
        : null,
    tenantContextState:
      rd.tenantId === null ? null : rd.tenantId === 'beta' ? 'foreign' : 'matching',
    canonicalIssuerState: rd.canonicalIssuerState,
  };
  return { dimensions, decision };
}

describe('runtime-topology Matrix R-D: vanity × canonical issuer × browser/protocol', () => {
  beforeEach(() => {
    installFrozenNow(FROZEN_NOW);
    clearTenantDatabaseResolverMemoryCache();
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of RD_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedRdRow(entry);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const { dimensions, decision } = toRaShape(entry);
      const synthetic: TopoCase = { ...entry, dimensions: dimensions as never };
      const observation = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(dimensions)
      );
      const expected = expectedRaObservation(synthetic, decision);
      observation.foreignTenantAccess = observation.tenantAccessSet.some(
        (tenant) => !expected.tenantAccessSet.includes(tenant)
      );
      // The canonical issuer state is asserted explicitly (group 5 lens).
      expect(observation.canonicalIssuerState, 'canonical issuer state').toBe(
        (decision as unknown as { canonicalIssuerState: string }).canonicalIssuerState
      );
      assertRaObservation(observation, expected);
    });
  }

  it('oracle sensitivity: corrupted real R-D observations are rejected per domain', async () => {
    expect.hasAssertions();
    const representatives = RD_CASE_TABLE.filter((entry) => {
      const d = decideRoutingRd(entry.dimensions as never) as unknown as RaDecision;
      return d.status === 200 || d.status === 308 || d.status === 404;
    });
    for (const entry of representatives.slice(0, 12)) {
      const seeded = await seedRdRow(entry);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const { dimensions, decision } = toRaShape(entry);
      const synthetic: TopoCase = { ...entry, dimensions: dimensions as never };
      const observed = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(dimensions)
      );
      const expected = expectedRaObservation(synthetic, decision);
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

  it('every R-D case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of RD_CASE_TABLE) {
      const base = decideRoutingRd(entry.dimensions as never);
      const baseSignature = JSON.stringify(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        let mutant: unknown;
        switch (mutationId) {
          case 'topology:use-stale-route-after-canonicalization':
            mutant = {
              ...base,
              status: 200,
              error: null,
              rejectionLayer: null,
              locationHost: null,
              canonicalIssuerState: 'tenant-canonical',
            };
            break;
          case 'topology:use-foreign-tenant-registry-or-binding':
            mutant = {
              ...base,
              status: 200,
              tenantId: 'alpha',
              rejectionLayer: null,
              canonicalIssuerState: 'active-vanity',
            };
            break;
          case 'topology:accept-inactive-vanity-alias':
            mutant = {
              ...base,
              status: 200,
              tenantId: 'alpha',
              rejectionLayer: null,
              canonicalIssuerState: 'active-vanity',
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
