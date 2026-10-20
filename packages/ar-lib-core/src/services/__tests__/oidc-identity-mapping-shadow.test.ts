import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

const { resolveBinding, executeMapping, loadDescriptor, assertReleaseSafety } = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  executeMapping: vi.fn(),
  loadDescriptor: vi.fn(),
  assertReleaseSafety: vi.fn(),
}));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: resolveBinding,
  assertRuntimeIdentityMappingReleaseSafety: assertReleaseSafety,
}));
vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({ executeRuntimeMapping: executeMapping }));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: vi.fn(
    async (input: { claims: Record<string, unknown> }) => input.claims
  ),
  loadDestinationProfileConsentDescriptor: loadDescriptor,
}));
vi.mock('../custom-claims/resolver', () => ({
  loadFeatureConfig: vi.fn(async () => ({ enabled: false })),
  createCustomClaimSchemaResolverFromSources: vi.fn(),
}));
vi.mock('../custom-claims/runtime-sources', () => ({
  resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(),
}));

import {
  applyOIDCIdentityMapping,
  OIDCIdentityMappingRuntimeError,
} from '../oidc-identity-mapping';
import {
  resetIdentityMappingResolutionDiffThrottle,
  resetIdentityMappingShadowCompareSettingCache,
} from '../identity-mapping-shadow-compare';
import { resetSwallowedIdentityMappingFailureThrottle } from '../identity-mapping-swallowed-failure';

/**
 * The shadow comparison must not change what a request resolves to, answers with, or fails with:
 * the same input gives the same result with it on, off, or failing. The current resolution is
 * the (mocked) resolver; the new selection and its set lookup are the real ones.
 */

const KEY = 'identity_mapping.oidc_default_set_id';
const FLAG = 'identity_mapping.shadow_compare_enabled';

const bindingFor = (setId: string) => ({
  fieldMappingSetId: setId,
  fieldMappingVersionId: `${setId}-version`,
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'profile-1',
  destinationProfileIds: ['profile-1'],
  catalog: { entries: [] },
  edges: [],
  transforms: [],
  validationRules: [],
  fieldMappingSet: {},
});

function kv(documents: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null),
  } as unknown as KVNamespace;
}

/** An Admin database that finds every set under the tenant, as active. */
function adminDatabase(queryOne?: () => Promise<unknown>): DatabaseAdapter {
  return {
    query: async () => [],
    queryOne: queryOne ?? (async () => ({ tenant_id: 'tenant-a', lifecycle_state: 'active' })),
    execute: async () => ({ success: true, rowsAffected: 0 }),
    transaction: async () => undefined,
    batch: async () => [],
    isHealthy: async () => ({ healthy: true, latencyMs: 0, type: 'test' }),
    getType: () => 'test',
    close: async () => undefined,
  } as unknown as DatabaseAdapter;
}

function settings(on: boolean, tenantDefault?: string): Record<string, unknown> {
  return {
    'settings:platform:identity-mapping': { [FLAG]: on },
    ...(tenantDefault
      ? { 'settings:tenant:tenant-a:identity-mapping': { [KEY]: tenantDefault } }
      : {}),
  };
}

describe('applyOIDCIdentityMapping with the shadow comparison', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetIdentityMappingResolutionDiffThrottle();
    resetIdentityMappingShadowCompareSettingCache();
    resetSwallowedIdentityMappingFailureThrottle();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The current resolution: an app that names a set gets it; one that names none gets the
    // activation that applies to the tenant (set-implicit).
    resolveBinding.mockImplementation(
      async (_adapter: unknown, params: { fieldMappingSetId?: string }) =>
        bindingFor(params.fieldMappingSetId ?? 'set-implicit')
    );
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
  });
  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const diffs = (): Array<Record<string, any>> =>
    warnSpy.mock.calls
      .map(([line]: [unknown]) => JSON.parse(String(line)) as Record<string, any>)
      .filter(
        (record: Record<string, any>) => record.action === 'identity_mapping_resolution_diff'
      );

  async function apply(options: {
    docs: Record<string, unknown>;
    selector?: Record<string, unknown> | null;
    admin?: DatabaseAdapter;
    waitUntil?: boolean;
  }) {
    const handed: Promise<unknown>[] = [];
    const result = await applyOIDCIdentityMapping({
      adapter: {} as DatabaseAdapter,
      env: { SETTINGS: kv(options.docs), DB_ADMIN: options.admin ?? adminDatabase() } as never,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      selector: (options.selector ?? null) as never,
      claims: { sub: 'user-1', email: 'alice@example.com' },
      ...(options.waitUntil === false
        ? {}
        : { waitUntil: (promise: Promise<unknown>) => void handed.push(promise) }),
    });
    await Promise.all(handed);
    return { result, handed };
  }

  it('returns exactly what it returns without the comparison, for each kind of request', async () => {
    const requests = [{ selector: null }, { selector: { fieldMappingSetId: 'set-own' } }];
    for (const request of requests) {
      const off = await apply({ docs: settings(false, 'set-tenant'), ...request });
      const on = await apply({ docs: settings(true, 'set-tenant'), ...request });
      expect(on.result).toEqual(off.result);
    }
  });

  it('resolves the request the way it did: the same lookup, first, with the comparison on', async () => {
    await apply({ docs: settings(false) });
    const withoutShadow = resolveBinding.mock.calls.map(([, params]) => params);
    resolveBinding.mockClear();

    await apply({ docs: settings(true, 'set-tenant') });
    const withShadow = resolveBinding.mock.calls.map(([, params]) => params);

    expect(withShadow[0]).toEqual(withoutShadow[0]);
    expect(withoutShadow).toHaveLength(1);
    // The comparison reads the set it selects, and nothing else.
    expect(withShadow.slice(1)).toEqual([
      expect.objectContaining({ fieldMappingSetId: 'set-tenant', ownerTenantId: 'tenant-a' }),
    ]);
  });

  it('does nothing more when it is off: no second lookup, no read of the Admin database', async () => {
    const reads: string[] = [];
    await apply({
      docs: settings(false, 'set-tenant'),
      admin: adminDatabase(async () => reads.push('queryOne')),
    });

    expect(resolveBinding).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([]);
    expect(diffs()).toEqual([]);
  });

  it('records an app with no set of its own whose tenant default would give it another', async () => {
    await apply({ docs: settings(true, 'set-tenant') });

    expect(diffs()).toEqual([
      expect.objectContaining({
        tenantId: 'tenant-a',
        clientId: 'client-a',
        failure_kind: 'set_differs',
        current_tier: 'implicit_tenant_activation',
        current_set_id: 'set-implicit',
        new_tier: 'tenant_default',
        new_set_id: 'set-tenant',
      }),
    ]);
  });

  it('records an app whose tenant activation would no longer apply', async () => {
    await apply({ docs: settings(true) });

    expect(diffs()).toEqual([
      expect.objectContaining({
        failure_kind: 'current_bound_new_none',
        current_set_id: 'set-implicit',
        new_none_reason: 'no_default',
      }),
    ]);
  });

  it('records nothing for an app that names its set and keeps it', async () => {
    await apply({ docs: settings(true, 'set-tenant'), selector: { fieldMappingSetId: 'set-own' } });
    expect(diffs()).toEqual([]);
  });

  it('records what the app would get where the current resolution failed and went on without', async () => {
    resolveBinding.mockImplementation(
      async (_adapter: unknown, params: { fieldMappingSetId?: string }) => {
        if (params.fieldMappingSetId) return bindingFor(params.fieldMappingSetId);
        throw new Error('no such table: field_mapping_activations');
      }
    );

    const { result } = await apply({ docs: settings(true, 'set-tenant') });

    // The request went on unmapped, as it does without the comparison.
    expect(result.binding).toBeNull();
    expect(result.claims).toEqual({ sub: 'user-1', email: 'alice@example.com' });
    expect(diffs()).toEqual([
      expect.objectContaining({
        failure_kind: 'current_none_new_bound',
        current_tier: 'none',
        current_resolution_failed: true,
        new_set_id: 'set-tenant',
      }),
    ]);
  });

  it('leaves a failure of the current resolution as it is', async () => {
    resolveBinding.mockResolvedValue(null);

    const outcome = (docs: Record<string, unknown>) =>
      applyOIDCIdentityMapping({
        adapter: {} as DatabaseAdapter,
        env: { SETTINGS: kv(docs), DB_ADMIN: adminDatabase() } as never,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selector: { fieldMappingSetId: 'set-own' },
        claims: { sub: 'user-1' },
      }).then(
        () => undefined,
        (error: unknown) => error
      );

    const off = await outcome(settings(false));
    const on = await outcome(settings(true));
    expect(on).toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    expect(on).toMatchObject({
      message: (off as Error).message,
      details: (off as OIDCIdentityMappingRuntimeError).details,
    });
  });

  it('is not waited for: the request completes while the comparison’s reads are still pending', async () => {
    const pending = new Promise<never>(() => undefined);
    const handed: Promise<unknown>[] = [];

    const result = await applyOIDCIdentityMapping({
      adapter: {} as DatabaseAdapter,
      env: {
        SETTINGS: kv(settings(true, 'set-tenant')),
        DB_ADMIN: adminDatabase(() => pending),
      } as never,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      selector: null,
      claims: { sub: 'user-1' },
      waitUntil: (promise) => void handed.push(promise),
    });

    expect(result.binding).toMatchObject({ fieldMappingSetId: 'set-implicit' });
    // The Worker was handed the comparison to keep alive, still running.
    expect(handed).toHaveLength(1);
    expect(diffs()).toEqual([]);
  });

  it('is not waited for without waitUntil either', async () => {
    const pending = new Promise<never>(() => undefined);
    const result = await applyOIDCIdentityMapping({
      adapter: {} as DatabaseAdapter,
      env: {
        SETTINGS: kv(settings(true, 'set-tenant')),
        DB_ADMIN: adminDatabase(() => pending),
      } as never,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      selector: null,
      claims: { sub: 'user-1' },
    });
    expect(result.binding).toMatchObject({ fieldMappingSetId: 'set-implicit' });
  });

  it('changes nothing for the request, and reads the settings once, while the KV is down', async () => {
    const baseline = await apply({ docs: settings(false) });
    const reads: string[] = [];
    const env = {
      SETTINGS: {
        get: async (key: string) => {
          reads.push(key);
          throw new Error('KV is down');
        },
      },
      DB_ADMIN: adminDatabase(),
    } as never;
    const call = () =>
      applyOIDCIdentityMapping({
        adapter: {} as DatabaseAdapter,
        env,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selector: null,
        claims: { sub: 'user-1', email: 'alice@example.com' },
      });

    const results = [];
    for (let i = 0; i < 10; i += 1) results.push(await call());
    await new Promise((resolve) => setTimeout(resolve, 10));

    for (const result of results) expect(result).toEqual(baseline.result);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(diffs()).toEqual([]);
  });

  it('swallows what the comparison throws: a log sink that fails, a lookup that fails', async () => {
    const baseline = await apply({ docs: settings(false, 'set-tenant') });
    warnSpy.mockImplementation(() => {
      throw new Error('the log sink is down');
    });

    const sinkDown = await apply({ docs: settings(true, 'set-tenant') });
    expect(sinkDown.result).toEqual(baseline.result);

    warnSpy.mockImplementation(() => undefined);
    warnSpy.mockClear();
    resetIdentityMappingResolutionDiffThrottle();
    resolveBinding.mockImplementation(
      async (_adapter: unknown, params: { fieldMappingSetId?: string }) => {
        if (params.fieldMappingSetId === 'set-tenant') throw new Error('boom: alice@example.com');
        return bindingFor(params.fieldMappingSetId ?? 'set-implicit');
      }
    );
    const lookupFails = await apply({ docs: settings(true, 'set-tenant') });
    expect(lookupFails.result).toEqual(baseline.result);
    // Recorded as a failure of the new selection, with no word of the error.
    expect(diffs()).toEqual([
      expect.objectContaining({
        failure_kind: 'new_selection_failed',
        new_failure_code: 'admin_database_unavailable',
      }),
    ]);
    expect(JSON.stringify(diffs())).not.toContain('alice@example.com');
  });
});
