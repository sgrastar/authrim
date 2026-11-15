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
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
} as unknown as DatabaseAdapter;
const subRef = (side: 'source' | 'destination') => ({ side, namespace: 'oidc.claim', path: 'sub' });

/** A persistent identifier written to sub, as the console saves "make a persistent identifier". */
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
    // The step takes no input edge: it is made from the account ID the runtime supplies.
    edges: [],
    transforms: [
      {
        id: 'step-pairwise',
        operation: 'persistent_identifier',
        inputEdgeIds: [],
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
  subjectType: 'public' as const,
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
    resolveBinding.mockResolvedValue(
      binding({ input: 'account', format: 'plain', algorithm: 'authrim_sha256' })
    );
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
      binding({
        input: 'account',
        format: 'plain',
        algorithm: 'authrim_sha256',
        audience: 'sector',
      })
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
    const dropped = binding({ input: 'account', format: 'plain', algorithm: 'authrim_sha256' });
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
    const sideless = binding({ input: 'account', format: 'plain', algorithm: 'authrim_sha256' });
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
      binding({
        input: 'account',
        format: 'plain',
        algorithm: 'authrim_sha256',
        audience: 'sector',
      })
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

  it('makes the sub from the value imported for the account into an identifier source', async () => {
    resolveBinding.mockResolvedValue(
      binding({ input: 'source', source: 'staff', format: 'plain', algorithm: 'authrim_sha256' })
    );
    const queryOne = vi.mocked(adminAdapter.queryOne);
    queryOne.mockImplementation((async (sql: string, params: unknown[]) =>
      sql.includes('identifier_source_values') &&
      params[0] === 'tenant-a' &&
      params[1] === 'staff' &&
      params[2] === 'usr_1'
        ? { value: 'E-1001' }
        : null) as never);
    const { claims } = await applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe(
      await computeIdentifier({
        algorithm: 'authrim_sha256',
        value: 'E-1001',
        audience: 'client-a',
        salt: new TextEncoder().encode('tenant-salt'),
      })
    );
    // Made from the value, not from the account ID.
    expect(claims.sub).not.toBe(await expected('client-a'));
    // An account the source holds no value for gets no sub (never the user ID, never one made
    // from the account ID).
    queryOne.mockResolvedValue(null);
    await expect(
      applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }))
    ).rejects.toMatchObject({ details: { code: 'policy.persistent_identifier_unavailable' } });
  });

  it('looks a kept identifier up by the account, and never computes one when the lookup fails', async () => {
    resolveBinding.mockResolvedValue(
      binding({
        input: 'account',
        format: 'plain',
        algorithm: 'authrim_sha256',
        stored: 'prefer',
        store: 'kept',
      })
    );
    const queryOne = vi.mocked(adminAdapter.queryOne);
    // Another account's row is never returned: the lookup is bound to this account's ID.
    queryOne.mockImplementation((async (sql: string, params: unknown[]) =>
      sql.includes('mapped_identifier_values') && params[3] === 'usr_1'
        ? { identifier: 'KEPT-FOR-USR-1' }
        : null) as never);
    const { claims } = await applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe('KEPT-FOR-USR-1');
    expect(queryOne.mock.calls.at(-1)?.[1]).toEqual(['tenant-a', 'kept', 'client-a', 'usr_1']);
    // A failed lookup stops the sign-in: the identifier is not made from the ID instead.
    queryOne.mockRejectedValue(new Error('database down'));
    await expect(
      applyOIDCIdentityMapping(input({ KEY_MANAGER: keyManager }))
    ).rejects.toMatchObject({ details: { code: 'policy.persistent_identifier_unavailable' } });
  });
});
