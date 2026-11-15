import { withExplicitMappingGraphs } from './mapping-graph-fixture';
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
    binding: withExplicitMappingGraphs(await resolveBinding()),
  }),
}));
vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: async (input: { claims: Record<string, unknown> }) =>
    input.claims,
  loadDestinationProfileConsentDescriptor: vi.fn(async () => null),
}));

import { applyOIDCIdentityMapping, deriveOIDCSubject } from '../oidc-identity-mapping';
import { PairwiseSubjectUnavailableError } from '../mapped-identifiers';

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

const SECTOR_PARAMS = {
  input: 'account',
  format: 'plain',
  algorithm: 'authrim_sha256',
  audience: 'sector',
};
const REDIRECTS = ['https://app.example/cb', 'https://app.example:8443/other'];

const pairwiseInput = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  input(env, { subjectType: 'pairwise' as const, redirectUris: REDIRECTS, ...extra });

describe('subject_type=pairwise', () => {
  beforeEach(() => {
    secretReads.length = 0;
    resolveBinding.mockResolvedValue(null);
  });

  it('gets the built-in pairwise sub with no mapping, equal to a sector persistent_identifier step', async () => {
    const built = await expected('app.example');
    const { claims } = await applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe(built);
    expect(claims.sub).not.toBe('usr_1');
    expect(secretReads).toEqual(['identifier-salt:default']);
    await expect(deriveOIDCSubject(pairwiseInput({ KEY_MANAGER: keyManager }))).resolves.toBe(
      built
    );
    // The value a step with input account, authrim_sha256, audience sector makes.
    resolveBinding.mockResolvedValue(binding(SECTOR_PARAMS));
    const viaStep = await applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }));
    expect(viaStep.claims.sub).toBe(built);
  });

  it('takes the sector from the sector_identifier_uri host', async () => {
    const { claims } = await applyOIDCIdentityMapping(
      pairwiseInput(
        { KEY_MANAGER: keyManager },
        {
          sectorIdentifier: 'https://sector.example/uris.json',
          redirectUris: ['https://a.example/cb', 'https://b.example/cb'],
        }
      )
    );
    expect(claims.sub).toBe(await expected('sector.example'));
  });

  it('fails rather than release the user id when there is no sector or no salt', async () => {
    await expect(
      applyOIDCIdentityMapping(
        pairwiseInput(
          { KEY_MANAGER: keyManager },
          { redirectUris: ['https://a.example/cb', 'https://b.example/cb'] }
        )
      )
    ).rejects.toBeInstanceOf(PairwiseSubjectUnavailableError);
    await expect(applyOIDCIdentityMapping(pairwiseInput({}))).rejects.toBeInstanceOf(
      PairwiseSubjectUnavailableError
    );
    await expect(deriveOIDCSubject(pairwiseInput({}))).rejects.toBeInstanceOf(
      PairwiseSubjectUnavailableError
    );
  });

  it('uses a recorded sub as it is, without reading the salt, the sector or a sub step', async () => {
    // No salt (the derivation would fail) and a sector-audience step on sub: neither is read.
    const input = pairwiseInput({}, { fixedSubject: 'recorded-sub', redirectUris: [] });
    resolveBinding.mockResolvedValue(null);
    expect((await applyOIDCIdentityMapping(input)).claims.sub).toBe('recorded-sub');
    await expect(deriveOIDCSubject(input)).resolves.toBe('recorded-sub');
    resolveBinding.mockResolvedValue(binding(SECTOR_PARAMS));
    const mapped = await applyOIDCIdentityMapping(input);
    expect(mapped.claims.sub).toBe('recorded-sub');
    expect(secretReads).toEqual([]);
    // Without a recorded sub the same input fails: the derivation needs them.
    await expect(
      applyOIDCIdentityMapping(pairwiseInput({}, { redirectUris: [] }))
    ).rejects.toBeDefined();
  });

  it('keeps a public client on the user id', async () => {
    const { claims } = await applyOIDCIdentityMapping(
      input({ KEY_MANAGER: keyManager }, { subjectType: 'public' as const })
    );
    expect(claims.sub).toBe('usr_1');
  });

  it('honours one sector-audience persistent_identifier step that writes sub', async () => {
    resolveBinding.mockResolvedValue(binding(SECTOR_PARAMS));
    const { claims } = await applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe(await expected('app.example'));
  });

  it('replaces a persistent identifier whose audience is not the sector', async () => {
    resolveBinding.mockResolvedValue(
      binding({ input: 'account', format: 'plain', algorithm: 'authrim_sha256' })
    );
    const client = await expected('client-a');
    const { claims } = await applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }));
    expect(claims.sub).not.toBe(client);
    expect(claims.sub).toBe(await expected('app.example'));
    await expect(deriveOIDCSubject(pairwiseInput({ KEY_MANAGER: keyManager }))).resolves.toBe(
      await expected('app.example')
    );
  });

  it('refuses several identifier rules writing sub', async () => {
    const two = binding(SECTOR_PARAMS);
    two.transforms.push({ ...two.transforms[0], id: 'step-two' });
    resolveBinding.mockResolvedValue(two);
    await expect(
      applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }))
    ).rejects.toThrow();
  });

  it('does not stand in the user id for a sub copied from an attribute that cannot be read', async () => {
    const copy = binding(SECTOR_PARAMS);
    copy.transforms = [];
    (copy as { edges: unknown[] }).edges = [
      {
        id: 'e-username',
        sourceRef: { side: 'source', namespace: 'oidc.claim', path: 'preferred_username' },
        targetRef: subRef('destination'),
      },
    ];
    copy.catalog.entries.push({
      id: 'field.source.preferred_username',
      namespace: 'oidc.claim',
      path: 'preferred_username',
      valueType: 'string',
      cardinality: 'single',
      classification: 'pii',
      targetType: 'destination-only',
    });
    resolveBinding.mockResolvedValue(copy);
    const unreadable = input(
      { KEY_MANAGER: keyManager },
      {
        sourceAttributes: async () => {
          throw new Error('user_attributes_not_available');
        },
      }
    );
    // The attribute is readable: the mapping's own sub.
    await expect(
      deriveOIDCSubject(
        input({ KEY_MANAGER: keyManager }, { sourceAttributes: { preferred_username: 'alice' } })
      )
    ).resolves.toBe('alice');
    // Not readable: no value at all, never the account's id in its place.
    await expect(deriveOIDCSubject(unreadable)).rejects.toBeDefined();
  });

  it('replaces a copy of the user id written to sub', async () => {
    const copy = binding(SECTOR_PARAMS);
    copy.transforms = [];
    (copy as { edges: unknown[] }).edges = [
      { id: 'e-sub', sourceRef: subRef('source'), targetRef: subRef('destination') },
    ];
    copy.catalog.entries.push({
      id: 'field.source.sub',
      namespace: 'oidc.claim',
      path: 'sub',
      valueType: 'string',
      cardinality: 'single',
      classification: 'internal',
      targetType: 'destination-only',
    });
    resolveBinding.mockResolvedValue(copy);
    const { claims } = await applyOIDCIdentityMapping(pairwiseInput({ KEY_MANAGER: keyManager }));
    expect(claims.sub).toBe(await expected('app.example'));
    expect(claims.sub).not.toBe('usr_1');
  });
});
