/**
 * Matrix R-A: request routing through the production `requestContextMiddleware`.
 *
 * Every row drives a real `Request` through a typed Hono app whose middleware chain is
 * `requestContextMiddleware` followed by a probe handler that exposes the established
 * tenant context and the canonical issuer via the exported `getRequestContext` /
 * `getRequestIssuer` helpers. The full cross-layer chain is exercised:
 * Host/forwarded host → request context → tenant existence/lifecycle → vanity binding →
 * signed runtime registry → D1 binding ownership → canonical issuer.
 *
 * The time is pinned per test; the env is a fresh, structurally correct object
 * (production bindings are mutable by design, so the suite freezes the clock, not the
 * env). Required group 1 (host × forwarded-host policy × request class) includes admin;
 * the dedicated admin preflight table covers X-Tenant-Id states × path match × trust.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Row } from '../fixtures/covering-array';
import { installFrozenNow, restoreRealClock } from '../fixtures/deterministic-clock';
import {
  RA_CASE_TABLE,
  decideRoutingRa,
  raDecisionSignature,
  type TopoCase,
  type RaDecision,
} from './cases';
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
  seedRegistryForTenant,
  observedTenantAccessSet,
} from './routing-env';
import {
  buildRaObservation,
  expectedRaObservation,
  assertRaObservation,
  intendedTenantOf,
  seedMiddlewareRow,
  raVanitySeedFor,
} from './harness';
import { clearTenantDatabaseResolverMemoryCache } from '../../../packages/ar-lib-core/src/services/tenant-database-resolver';

const FROZEN_NOW = 1700000000;

// =============================================================================
// R-A mutation witnesses
// =============================================================================

function raMutationCandidate(entry: TopoCase, mutationId: string): RaDecision {
  const base = decideRoutingRa(entry.dimensions as Row);
  switch (mutationId) {
    case 'topology:trust-forwarded-host-without-config':
      // Trusting the forwarded host without AUTHRIM_TRUST_FORWARDED_HOST.
      return {
        ...base,
        tenantId: 'beta',
        tenantSource: 'forwarded',
        issuerHost: 'beta.authrim.example',
        tenantContextState: 'foreign',
      };
    case 'topology:accept-inactive-vanity-alias':
      // Accepting an inactive vanity alias as the tenant source.
      return {
        ...base,
        status: 200,
        tenantId: 'alpha',
        tenantSource: 'vanity',
        rejectionLayer: null,
      };
    case 'topology:use-foreign-tenant-registry-or-binding':
      // Resolving a cross-tenant vanity cache as the tenant.
      return {
        ...base,
        status: 200,
        tenantId: 'alpha',
        tenantSource: 'vanity',
        rejectionLayer: null,
      };
    case 'topology:accept-bad-signature-snapshot':
      // Accepting a bad-signature runtime snapshot.
      return {
        ...base,
        status: 200,
        rejectionLayer: null,
        registryStatus: 'valid',
        tenantId: base.tenantId ?? 'alpha',
      };
    case 'topology:use-quarantined-route-as-active':
      // Using a quarantined route as active.
      return { ...base, status: 200, rejectionLayer: null, registryStatus: 'valid' };
    case 'topology:fall-back-to-common-database-when-required-binding-missing':
      // Falling back to a common database when the required binding is missing.
      return { ...base, status: 200, rejectionLayer: null, bindingRef: 'DB' };
    case 'topology:reuse-stale-runtime-generation-cache':
      // Serving from a stale runtime generation cache (a success row changes registry
      // status; an already-failed row must not collapse to the same decision).
      return base.status === 200
        ? {
            ...base,
            registryStatus: 'bad-signature',
            rejectionLayer: 'metadata-context',
            status: 409,
            error: 'invalid_snapshot_signature',
          }
        : { ...base, status: 200, rejectionLayer: null, tenantId: base.tenantId ?? 'alpha' };
    case 'topology:use-stale-route-after-canonicalization':
      // Serving the non-canonical alias after the canonicalization check.
      return { ...base, status: 200, rejectionLayer: null, locationHost: null };
    default:
      throw new Error(`Unknown R-A mutation ${mutationId}`);
  }
}

// =============================================================================
// Admin preflight table: X-Tenant-Id states × path match × forwarded trust
// =============================================================================

interface AdminPreflight {
  id: string;
  title: string;
  xTenantId: string | null;
  pathTenant: string;
  forwardedHost: string | null;
  trustEnabled: boolean;
  expected: {
    status: number;
    error: string | null;
    errorDescription: string | null;
    tenantId: string | null;
    issuerHost: string | null;
  };
}

const ADMIN_PREFLIGHTS: AdminPreflight[] = [
  {
    id: 'topo-admin-001',
    title: 'matching X-Tenant-Id, no forwarded host',
    xTenantId: 'alpha',
    pathTenant: 'alpha',
    forwardedHost: null,
    trustEnabled: false,
    expected: {
      status: 200,
      error: null,
      errorDescription: null,
      tenantId: 'alpha',
      issuerHost: 'alpha.authrim.example',
    },
  },
  {
    id: 'topo-admin-002',
    title: 'matching X-Tenant-Id, conflicting forwarded host with trust',
    xTenantId: 'alpha',
    pathTenant: 'alpha',
    forwardedHost: 'beta.authrim.example',
    trustEnabled: true,
    expected: {
      status: 200,
      error: null,
      errorDescription: null,
      tenantId: 'alpha',
      issuerHost: 'beta.authrim.example',
    },
  },
  {
    id: 'topo-admin-003',
    title: 'matching X-Tenant-Id, conflicting forwarded host without trust',
    xTenantId: 'alpha',
    pathTenant: 'alpha',
    forwardedHost: 'beta.authrim.example',
    trustEnabled: false,
    expected: {
      status: 200,
      error: null,
      errorDescription: null,
      tenantId: 'alpha',
      issuerHost: 'alpha.authrim.example',
    },
  },
  {
    id: 'topo-admin-004',
    title: 'matching X-Tenant-Id, matching forwarded host with trust',
    xTenantId: 'alpha',
    pathTenant: 'alpha',
    forwardedHost: 'alpha.authrim.example',
    trustEnabled: true,
    expected: {
      status: 200,
      error: null,
      errorDescription: null,
      tenantId: 'alpha',
      issuerHost: 'alpha.authrim.example',
    },
  },
  {
    id: 'topo-admin-005',
    title: 'missing X-Tenant-Id is rejected before resolution',
    xTenantId: null,
    pathTenant: 'alpha',
    forwardedHost: null,
    trustEnabled: false,
    expected: {
      status: 400,
      error: 'invalid_request',
      errorDescription: 'X-Tenant-Id header is required',
      tenantId: null,
      issuerHost: null,
    },
  },
  {
    id: 'topo-admin-006',
    title: 'malformed X-Tenant-Id is rejected before resolution',
    xTenantId: 'BAD ID!',
    pathTenant: 'alpha',
    forwardedHost: null,
    trustEnabled: false,
    expected: {
      status: 400,
      error: 'invalid_request',
      errorDescription: 'X-Tenant-Id header has an invalid format',
      tenantId: null,
      issuerHost: null,
    },
  },
  {
    id: 'topo-admin-007',
    title: 'foreign X-Tenant-Id (beta) does not match the path tenant (alpha)',
    xTenantId: 'beta',
    pathTenant: 'alpha',
    forwardedHost: null,
    trustEnabled: false,
    expected: {
      status: 400,
      error: 'invalid_request',
      errorDescription: 'X-Tenant-Id must match the tenant path parameter',
      tenantId: null,
      issuerHost: null,
    },
  },
  {
    id: 'topo-admin-008',
    title: 'matching X-Tenant-Id does not match a mismatching path tenant',
    xTenantId: 'alpha',
    pathTenant: 'beta',
    forwardedHost: null,
    trustEnabled: false,
    expected: {
      status: 400,
      error: 'invalid_request',
      errorDescription: 'X-Tenant-Id must match the tenant path parameter',
      tenantId: null,
      issuerHost: null,
    },
  },
];

// =============================================================================
// R-A tests
// =============================================================================

describe('runtime-topology Matrix R-A: request routing', () => {
  beforeEach(() => {
    installFrozenNow(FROZEN_NOW);
    clearTenantDatabaseResolverMemoryCache();
  });

  afterEach(() => {
    restoreRealClock();
  });

  for (const entry of RA_CASE_TABLE) {
    it(`${entry.id} ${entry.title}`, async () => {
      expect.hasAssertions();
      const seeded = await seedMiddlewareRow(entry.dimensions, raVanitySeedFor);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const observation = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(entry.dimensions)
      );
      const expected = expectedRaObservation(entry, decideRoutingRa(entry.dimensions as Row));
      observation.foreignTenantAccess = observation.tenantAccessSet.some(
        (tenant) => !expected.tenantAccessSet.includes(tenant)
      );
      assertRaObservation(observation, expected);
    });
  }

  for (const preflight of ADMIN_PREFLIGHTS) {
    it(`${preflight.id} ${preflight.title}`, async () => {
      expect.hasAssertions();
      const kit = await createTopologyKit({
        deploymentMode: 'multi',
        forwardedPolicy: preflight.trustEnabled ? 'enabled' : 'disabled',
        registryState: 'valid',
      });
      seedTenantRow(kit, 'alpha', 'active');
      await seedRegistryForTenant(kit, 'alpha', 'valid', 'present');
      const app = createProbeApp(kit.env);
      const headers: Record<string, string> = { Host: 'alpha.authrim.example' };
      if (preflight.xTenantId !== null) headers['X-Tenant-Id'] = preflight.xTenantId;
      if (preflight.forwardedHost !== null)
        headers['X-Authrim-Forwarded-Host'] = preflight.forwardedHost;
      const request = new Request(
        `https://alpha.authrim.example/api/admin/settings/logging/tenant/${preflight.pathTenant}`,
        { method: 'GET', headers }
      );
      const result = await runProbe(app, kit.env, request, kit.ledger);
      expect(result.status, result.bodyText).toBe(preflight.expected.status);
      expect(result.error).toBe(preflight.expected.error);
      expect(result.errorDescription).toBe(preflight.expected.errorDescription);
      if (preflight.expected.status === 200) {
        expect(result.body?.tenantId).toBe(preflight.expected.tenantId);
        expect(result.body?.issuer).toBe(`https://${preflight.expected.issuerHost}`);
      }
      // No foreign tenant registry or binding access for any admin shape.
      const access = observedTenantAccessSet(kit.ledger);
      expect(
        access.every((tenant) => tenant === 'alpha'),
        `admin access set ${access.join(',')}`
      ).toBe(true);
    });
  }

  it('admin rows never touch the foreign tenant registry or binding', async () => {
    expect.hasAssertions();
    const kit = await createTopologyKit({
      deploymentMode: 'multi',
      forwardedPolicy: 'enabled',
      registryState: 'valid',
    });
    seedTenantRow(kit, 'alpha', 'active');
    await seedRegistryForTenant(kit, 'alpha', 'valid', 'present');
    const app = createProbeApp(kit.env);
    const request = new Request(
      `https://alpha.authrim.example/api/admin/settings/logging/tenant/alpha`,
      {
        method: 'GET',
        headers: {
          Host: 'alpha.authrim.example',
          'X-Tenant-Id': 'alpha',
          'X-Authrim-Forwarded-Host': 'beta.authrim.example',
        },
      }
    );
    const result = await runProbe(app, kit.env, request, kit.ledger);
    expect(result.status).toBe(200);
    expect(result.body?.tenantId).toBe('alpha');
    const access = observedTenantAccessSet(kit.ledger);
    expect(access).toEqual(['alpha']);
    const foreignTargets = kit.ledger
      .all()
      .filter((entry) => entry.target.includes('tenant:beta:'));
    expect(foreignTargets).toEqual([]);
  });

  it('failure logs never expose signature or JWK material', async () => {
    expect.hasAssertions();
    const {
      getRuntimeRegistryKeys,
      buildSnapshot,
      signSnapshot,
      corruptSnapshotSignature,
      RUNTIME_REGISTRY_GENERATION_KEY,
      RUNTIME_REGISTRY_SNAPSHOT_KEY,
    } = await import('./registry-fixtures');
    const { makeGenerationDocument } = await import('./routing-env');
    const keys = await getRuntimeRegistryKeys();
    const kit = await createTopologyKit({
      deploymentMode: 'multi',
      forwardedPolicy: 'disabled',
      registryState: 'valid',
      extraEnv: { LOG_LEVEL: 'debug' },
    });
    seedTenantRow(kit, 'alpha', 'active');
    const nowMs = Date.now();
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
          databaseId: 'db-core-alpha',
        },
      ],
      publishedAt: new Date(nowMs - 60_000).toISOString(),
      expiresAt: new Date(nowMs + 3600_000).toISOString(),
    });
    const signed = await signSnapshot(snapshot, new Date(nowMs).toISOString());
    const signature = signed.metadata.signature as string;
    corruptSnapshotSignature(signed);
    await kit.runtimeRegistry.put(
      RUNTIME_REGISTRY_GENERATION_KEY('alpha'),
      makeGenerationDocument(5, 'active', 0, nowMs)
    );
    await kit.runtimeRegistry.put(RUNTIME_REGISTRY_SNAPSHOT_KEY('alpha'), JSON.stringify(signed));
    const app = createProbeApp(kit.env);
    const request = new Request(`https://alpha.authrim.example/api/v1/login/interactions/start`, {
      method: 'POST',
      headers: { Host: 'alpha.authrim.example' },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runProbe(app, kit.env, request, kit.ledger);
      expect(result.status).toBe(409);
      const captured = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .map((args) => args.map(String).join(' '))
        .join('\n');
      expect(captured, 'log must not contain the snapshot signature').not.toContain(signature);
      expect(captured, 'log must not contain private JWK material').not.toContain(
        keys.primary.privateJwk.d
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('oracle sensitivity: corrupted real R-A observations are rejected per domain', async () => {
    expect.hasAssertions();
    // Representative rows covering every rejection layer and a success.
    const representatives = RA_CASE_TABLE.filter((entry) => {
      const decision = decideRoutingRa(entry.dimensions as Row);
      const layer = decision.rejectionLayer;
      if (decision.status === 200) return true;
      if (layer === 'tenant-resolution' && String(entry.dimensions.hostClass) === 'unrelated')
        return true;
      if (
        layer === 'metadata-context' &&
        String(entry.dimensions.registryState) === 'bad-signature'
      )
        return true;
      if (layer === 'tenant-exists') return true;
      if (layer === 'vanity-canonicalization') return true;
      if (layer === 'binding-policy') return true;
      if (layer === 'admin-header') return true;
      return false;
    });
    expect(representatives.length).toBeGreaterThanOrEqual(6);
    for (const entry of representatives.slice(0, 10)) {
      const seeded = await seedMiddlewareRow(entry.dimensions, raVanitySeedFor);
      const result = await runProbe(seeded.app, seeded.kit.env, seeded.request, seeded.kit.ledger);
      const observed = await buildRaObservation(
        seeded.kit,
        result,
        seeded.secrets,
        intendedTenantOf(entry.dimensions)
      );
      const expected = expectedRaObservation(entry, decideRoutingRa(entry.dimensions as Row));
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

  it('every R-A case carries a discriminating mutation witness', () => {
    expect.hasAssertions();
    for (const entry of RA_CASE_TABLE) {
      const base = decideRoutingRa(entry.dimensions as Row);
      const baseSignature = raDecisionSignature(base);
      expect(entry.mutationIds.length).toBeGreaterThan(0);
      for (const mutationId of entry.mutationIds) {
        const mutant = raMutationCandidate(entry, mutationId);
        expect(raDecisionSignature(mutant), `${entry.id} mutation ${mutationId}`).not.toBe(
          baseSignature
        );
      }
    }
  });
});
