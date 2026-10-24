import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * The release of claims for an explanation: `trace` records what each step decided (never a
 * value), and `fixture` keeps a test user from reading anything kept for an account (custom
 * fields, the consent record, a persistent identifier's secret). The selection, the mapping
 * runtime and the profile filter are stood in for, as in oidc-identity-mapping.test.ts.
 */

const { resolveBinding, executeMapping, filterClaims, loadDescriptor, loadFeatureConfig } =
  vi.hoisted(() => ({
    resolveBinding: vi.fn(),
    executeMapping: vi.fn(),
    filterClaims: vi.fn(async (input: { claims: Record<string, unknown> }) => input.claims),
    loadDescriptor: vi.fn(),
    loadFeatureConfig: vi.fn(async () => ({ enabled: true })),
  }));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: vi.fn(),
  assertRuntimeIdentityMappingReleaseSafety: vi.fn(),
}));
vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: async (input: unknown) => {
    const answer = await resolveBinding(input);
    const chain = [
      { tier: 'client', state: 'set', setId: 'set-1' },
      { tier: 'tenant_default', state: 'not_consulted' },
      { tier: 'platform_default', state: 'not_consulted' },
    ];
    return answer
      ? { selection: { kind: 'bound', tier: 'client', setId: 'set-1', chain }, binding: answer }
      : { selection: { kind: 'none', reason: 'no_default', chain }, binding: null };
  },
}));
vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({ executeRuntimeMapping: executeMapping }));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: filterClaims,
  loadDestinationProfileConsentDescriptor: loadDescriptor,
}));
vi.mock('../custom-claims/resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../custom-claims/resolver')>()),
  loadFeatureConfig,
}));

import { applyOIDCIdentityMapping, type OIDCReleaseTrace } from '../oidc-identity-mapping';
import { IdentityMappingResolutionError } from '../identity-mapping-set-binding';

const adapter = {} as DatabaseAdapter;
const adminAdapter = { query: vi.fn(), queryOne: vi.fn() } as unknown as DatabaseAdapter;

const edge = (id: string, source: string, target: string) => ({
  id,
  sourceRef: { side: 'source', namespace: 'authrim.profile', path: source },
  targetRef: { side: 'destination', namespace: 'oidc.claim', path: target },
});
const binding = {
  tenantId: 'tenant-a',
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'profile-1',
  destinationProfileIds: ['profile-1'],
  catalog: { entries: [] },
  edges: [edge('e-aff', 'affiliation', 'affiliation'), edge('e-sub', 'sub', 'sub')],
  transforms: [
    {
      id: 'pairwise',
      inputEdgeIds: ['e-sub'],
      operation: 'oidc_pairwise_sub',
      parameters: { persistentIdentifierProfileId: 'pid-1' },
      outputTargetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
    },
  ],
  validationRules: [],
  fieldMappingSet: {},
};

const run = (overrides: Record<string, unknown> = {}) =>
  applyOIDCIdentityMapping({
    adapter,
    // No KEY_MANAGER: an account's pairwise sub could not be derived here.
    env: { DB_ADMIN: adminAdapter as never },
    tenantId: 'tenant-a',
    clientId: 'client-a',
    destinationSurface: 'userinfo',
    grantedScopes: ['openid', 'profile'],
    claims: { sub: 'tu_1' },
    sourceAttributes: { affiliation: 'MARKER-staff', nickname: '' },
    ...overrides,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  resolveBinding.mockResolvedValue(binding);
  loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
  executeMapping.mockImplementation(
    (input: { runtimeContext: { oidc: { persistentIdentifiers: Record<string, string> } } }) => ({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'affiliation' },
          value: 'MARKER-staff',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: input.runtimeContext.oidc.persistentIdentifiers['pid-1'],
        },
      ],
    })
  );
});

describe('the release for a test user', () => {
  it('derives no persistent identifier and reports its claim as not evaluated', async () => {
    const trace: OIDCReleaseTrace = {};

    const result = await run({ trace, fixture: { consent: 'all' } });

    expect(result.claims.sub).toMatch(/^authrim:not-evaluated:[0-9a-f-]{36}$/);
    // The profile does not judge the placeholder as if it were the identifier.
    expect(filterClaims).toHaveBeenCalledWith(
      expect.objectContaining({ unevaluatedClaims: new Set(['sub']) })
    );
    expect(trace.mapping).toEqual([
      { claim: 'affiliation', sources: ['affiliation'], produced: true },
      { claim: 'sub', sources: ['sub'], produced: true, notEvaluated: true },
    ]);
  });

  it('judges a value a later step wrote over the placeholder as usual', async () => {
    executeMapping.mockImplementation(
      (input: { runtimeContext: { oidc: { persistentIdentifiers: Record<string, string> } } }) => ({
        status: 'success',
        values: [
          {
            sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
            value: input.runtimeContext.oidc.persistentIdentifiers['pid-1'],
          },
          {
            sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
            value: 'copied-from-an-attribute',
          },
        ],
      })
    );
    const trace: OIDCReleaseTrace = {};

    await run({ trace, fixture: { consent: 'all' } });

    expect(filterClaims).toHaveBeenCalledWith(
      expect.objectContaining({ unevaluatedClaims: new Set() })
    );
    expect(trace.mapping?.find((entry) => entry.claim === 'sub')).not.toHaveProperty(
      'notEvaluated'
    );
  });

  it('takes no attribute for the placeholder, whatever it holds', async () => {
    const placeholders: string[] = [];
    executeMapping.mockImplementation(
      (input: { runtimeContext: { oidc: { persistentIdentifiers: Record<string, string> } } }) => {
        placeholders.push(input.runtimeContext.oidc.persistentIdentifiers['pid-1']);
        return {
          status: 'success',
          values: [
            {
              sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'affiliation' },
              // What a test user could type, guessing the placeholder of an earlier call.
              value: placeholders[0],
            },
          ],
        };
      }
    );

    await run({ fixture: { consent: 'all' } });
    await run({ fixture: { consent: 'all' } });

    expect(placeholders[0]).not.toBe(placeholders[1]);
    expect(filterClaims.mock.calls.at(-1)?.[0]).toMatchObject({ unevaluatedClaims: new Set() });
  });

  it('fails for an account without the persistent identifier’s key, as before', async () => {
    await expect(run()).rejects.toMatchObject({
      details: { code: 'policy.persistent_identifier_profile_not_found' },
    });
  });

  it('reads no custom field for it, and gives the profile filter the assumed consent', async () => {
    resolveBinding.mockResolvedValue({
      ...binding,
      transforms: [],
      edges: [edge('e', 'dept', 'dept')],
    });

    await run({ fixture: { consent: 'none' }, sourceAttributes: {} });

    expect(loadFeatureConfig).not.toHaveBeenCalled();
    expect(filterClaims).toHaveBeenCalledWith(expect.objectContaining({ assumedConsent: 'none' }));

    // An account's missing attribute is looked for among the tenant's custom fields (whose
    // stores this test does not set up).
    await expect(run({ sourceAttributes: {} })).rejects.toThrow();
    expect(loadFeatureConfig).toHaveBeenCalled();
  });
});

describe('the trace', () => {
  it('records presence and decisions, never a value', async () => {
    const trace: OIDCReleaseTrace = {};

    await run({ trace, fixture: { consent: 'all' } });

    expect(trace.binding).toEqual({
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'version-1',
      ownerTenantId: 'tenant-a',
      destinationProfileId: 'profile-1',
    });
    expect(trace.beforeRelease).toEqual({ sub: 'present', affiliation: 'present' });
    expect(JSON.stringify(trace)).not.toContain('MARKER');
  });

  it('records an empty value as empty, and a selection of none as no binding', async () => {
    resolveBinding.mockResolvedValue(null);
    const trace: OIDCReleaseTrace = {};

    await run({ trace, claims: { sub: 'tu_1', nickname: '', email: 'x@example.test' } });

    expect(trace.binding).toBeNull();
    expect(trace.mapping).toEqual([]);
    expect(trace.beforeRelease).toEqual({ sub: 'present', nickname: 'empty', email: 'present' });
  });

  it('records why the set could not be read, before the failure becomes the release’s error', async () => {
    resolveBinding.mockRejectedValue(
      new IdentityMappingResolutionError('set_inactive', 'client', 'set-1')
    );
    const trace: OIDCReleaseTrace = {};

    await expect(run({ trace })).rejects.toMatchObject({
      details: { code: 'policy.missing_identity_mapping_binding' },
    });
    expect(trace.resolutionFailure).toEqual({ code: 'set_inactive', tier: 'client' });
  });

  it('is left alone when not asked for, and changes nothing of the answer', async () => {
    // No persistent identifier: its placeholder is new for every call.
    resolveBinding.mockResolvedValue({ ...binding, transforms: [] });
    const withTrace = await run({ trace: {}, fixture: { consent: 'all' } });
    const without = await run({ fixture: { consent: 'all' } });
    expect(withTrace).toEqual(without);
  });
});
