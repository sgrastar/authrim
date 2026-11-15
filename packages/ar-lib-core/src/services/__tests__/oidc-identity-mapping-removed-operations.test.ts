import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

/**
 * A mapping version saved before the persistent identifier profiles were removed may still hold
 * the old `oidc_pairwise_sub` / `saml_edu_person_targeted_id` operations. The real mapping
 * runtime (not stood in for) must fail the whole mapping on them, so the sign-in is refused and
 * the user's id is never released in their place.
 */

const { resolveBinding, filterClaims, loadDescriptor, loadFeatureConfig } = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
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
    const chain = [
      { tier: 'client', state: 'set', setId: 'set-1' },
      { tier: 'tenant_default', state: 'not_consulted' },
      { tier: 'platform_default', state: 'not_consulted' },
    ];
    return {
      selection: { kind: 'bound', tier: 'client', setId: 'set-1', chain },
      binding: (await resolveBinding(input)) as unknown,
    };
  },
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: filterClaims,
  loadDestinationProfileConsentDescriptor: loadDescriptor,
}));
vi.mock('../custom-claims/resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../custom-claims/resolver')>()),
  loadFeatureConfig,
}));

import {
  applyOIDCIdentityMapping,
  deriveOIDCSubject,
  OIDCIdentityMappingRuntimeError,
} from '../oidc-identity-mapping';

const target = { side: 'destination', namespace: 'oidc.claim', path: 'sub' };
const binding = (operation: string) => ({
  tenantId: 'tenant-a',
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'profile-1',
  destinationProfileIds: ['profile-1'],
  catalog: {
    identity: { id: 'oidc.test', version: '1', contentHash: 'none', compatibilityRange: '*' },
    entries: [],
  },
  edges: [
    {
      id: 'e-sub',
      sourceRef: { side: 'source', namespace: 'authrim.profile', path: 'sub' },
      targetRef: target,
    },
  ],
  transforms: [
    {
      id: 'removed-step',
      inputEdgeIds: ['e-sub'],
      operation,
      parameters: { persistentIdentifierProfileId: 'pid-1' },
      outputTargetRef: target,
    },
  ],
  validationRules: [],
  fieldMappingSet: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
});

describe('an OIDC mapping version saved with a removed operation', () => {
  it.each(['oidc_pairwise_sub', 'saml_edu_person_targeted_id'])(
    'fails at run time for %s, so the sign-in is refused and nothing is released',
    async (operation) => {
      resolveBinding.mockResolvedValue(binding(operation));

      const released = applyOIDCIdentityMapping({
        subjectType: 'public',
        adapter: {} as DatabaseAdapter,
        env: { DB_ADMIN: { query: vi.fn(), queryOne: vi.fn() } as unknown as DatabaseAdapter },
        tenantId: 'tenant-a',
        clientId: 'client-a',
        destinationSurface: 'userinfo',
        grantedScopes: ['openid'],
        claims: { sub: 'user-1' },
        sourceAttributes: { sub: 'user-1' },
      } as never);

      await expect(released).rejects.toBeInstanceOf(OIDCIdentityMappingRuntimeError);
      expect(filterClaims).not.toHaveBeenCalled();
    }
  );

  it.each(['oidc_pairwise_sub', 'saml_edu_person_targeted_id'])(
    'yields no subject for id_token_hint matching either (%s)',
    async (operation) => {
      resolveBinding.mockResolvedValue(binding(operation));
      await expect(
        deriveOIDCSubject({
          subjectType: 'public',
          adapter: {} as DatabaseAdapter,
          env: { DB_ADMIN: { query: vi.fn(), queryOne: vi.fn() } as unknown as DatabaseAdapter },
          tenantId: 'tenant-a',
          clientId: 'client-a',
          claims: { sub: 'user-1' },
        } as never)
      ).rejects.toBeInstanceOf(OIDCIdentityMappingRuntimeError);
    }
  );
});
