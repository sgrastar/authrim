import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';
import { computeIdentifier } from '../identifier-algorithms';

// The database boundary only: the mapping engine and the identifier preparation run for real.
const { resolveBinding } = vi.hoisted(() => ({ resolveBinding: vi.fn() }));
vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: vi.fn(),
  assertRuntimeIdentityMappingReleaseSafety: vi.fn(),
}));
vi.mock('../identity-mapping-resolution', () => ({
  resolveOidcIdentityMappingBinding: async () => ({
    selection: { kind: 'bound', tier: 'tenant_default', setId: 'set-1', chain: [] },
    binding: (await resolveBinding()) as unknown,
  }),
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: async (input: { claims: Record<string, unknown> }) =>
    input.claims,
  loadDestinationProfileConsentDescriptor: vi.fn(async () => null),
}));

import { applyOIDCIdentityMapping, deriveOIDCSubject } from '../oidc-identity-mapping';

const adapter = {} as DatabaseAdapter;
const adminAdapter = {
  query: vi.fn(async () => []),
  queryOne: vi.fn(),
} as unknown as DatabaseAdapter;
const subRef = (side: 'source' | 'destination') => ({ side, namespace: 'oidc.claim', path: 'sub' });

/** sub → (pairwise identifier) → sub, as the console saves "make a persistent identifier". */
function binding(parameters: Record<string, unknown>) {
  return {
    id: 'binding-1',
    tenantId: 'tenant-a',
    fieldMappingSetId: 'set-1',
    fieldMappingVersionId: 'version-1',
    mappingSnapshotHash: 'hash-1',
    catalog: {
      identity: { id: 'c', version: '1', contentHash: 'c', compatibilityRange: '^0.2.0' },
      entries: [
        {
          id: 'field.oidc.sub',
          namespace: 'oidc.claim',
          path: 'sub',
          valueType: 'string',
          cardinality: 'single',
          classification: 'internal',
          targetType: 'destination-only',
        },
      ],
    },
    edges: [{ id: 'edge-sub', sourceRef: subRef('source'), targetRef: subRef('destination') }],
    transforms: [
      {
        id: 'step-pairwise',
        operation: 'persistent_identifier',
        inputEdgeIds: ['edge-sub'],
        parameters,
        outputTargetRef: subRef('destination'),
      },
    ],
    validationRules: [],
    fieldMappingSet: {},
    activationScope: {},
    destinationNamespace: 'oidc.claim',
    destinationProfileId: 'profile-1',
    destinationProfileIds: ['profile-1'],
  };
}

const secretReads: string[] = [];
const keyManager = {
  idFromName: (name: string) => name,
  get: () => ({
    getOrCreateSecretRpc: async (ref: string) => {
      secretReads.push(ref);
      return { active: { value: 'tenant-salt' } };
    },
  }),
};

const input = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  adapter,
  env: { DB_ADMIN: adminAdapter as never, ...env },
  tenantId: 'tenant-a',
  clientId: 'client-a',
  claims: { sub: 'usr_1', email: 'a@example.test' },
  ...extra,
});

const expected = (audience: string) =>
  computeIdentifier({
    algorithm: 'authrim_sha256',
    value: 'usr_1',
    audience,
    salt: new TextEncoder().encode('tenant-salt'),
  });

describe('OIDC persistent_identifier', () => {
  beforeEach(() => {
    secretReads.length = 0;
    resolveBinding.mockResolvedValue(binding({ format: 'plain', algorithm: 'authrim_sha256' }));
  });

  it('issues the pairwise sub in place of the user id, made with the tenant salt', async () => {
    const { claims } = await applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe(await expected('client-a'));
    expect(Object.values(claims)).not.toContain('usr_1');
    expect(secretReads).toEqual(['identifier-salt:default']);
    await expect(deriveOIDCSubject(input({ KEY_MANAGER: keyManager }))).resolves.toBe(
      await expected('client-a')
    );
  });

  it('uses the sector shared by the redirect URIs', async () => {
    resolveBinding.mockResolvedValue(
      binding({ format: 'plain', algorithm: 'authrim_sha256', audience: 'sector' })
    );
    const { claims } = await applyOIDCIdentityMapping(
      input(
        { KEY_MANAGER: keyManager },
        { redirectUris: ['https://app.example/cb', 'https://app.example/other'] }
      )
    );
    expect(claims.sub).toBe(await expected('app.example'));
  });

  it('refuses when the identifier is made but dropped before release', async () => {
    // A catalog without the sub entry drops the identifier: the user id must not go out instead.
    const dropped = binding({ format: 'plain', algorithm: 'authrim_sha256' });
    dropped.catalog.entries = [];
    resolveBinding.mockResolvedValue(dropped);
    const failure = { details: { code: 'policy.persistent_identifier_unavailable' } };
    await expect(
      applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }))
    ).rejects.toMatchObject(failure);
    await expect(deriveOIDCSubject(input({ KEY_MANAGER: keyManager }))).rejects.toMatchObject(
      failure
    );
    // A target that does not say it is a destination is never a release either.
    const sideless = binding({ format: 'plain', algorithm: 'authrim_sha256' });
    sideless.transforms[0].outputTargetRef = {
      namespace: 'oidc.claim',
      path: 'sub',
    } as unknown as (typeof sideless.transforms)[0]['outputTargetRef'];
    resolveBinding.mockResolvedValue(sideless);
    await expect(deriveOIDCSubject(input({ KEY_MANAGER: keyManager }))).rejects.toMatchObject(
      failure
    );
  });

  it('refuses rather than issue the user id when the identifier cannot be made', async () => {
    const failure = { details: { code: 'policy.persistent_identifier_unavailable' } };
    await expect(applyOIDCIdentityMapping(input({}))).rejects.toMatchObject(failure);
    // The subject alone (id_token_hint matching) is refused the same way.
    await expect(deriveOIDCSubject(input({}))).rejects.toMatchObject(failure);
    resolveBinding.mockResolvedValue(
      binding({ format: 'plain', algorithm: 'authrim_sha256', audience: 'sector' })
    );
    await expect(
      applyOIDCIdentityMapping(
        input(
          { KEY_MANAGER: keyManager },
          { redirectUris: ['https://a.example/cb', 'https://b.example/cb'] }
        )
      )
    ).rejects.toMatchObject(failure);
  });
});
