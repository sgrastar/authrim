import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseAdapter } from '../../db/adapter';

const {
  resolveBinding,
  executeMapping,
  filterClaims,
  filterBaselineClaims,
  loadDescriptor,
  assertReleaseSafety,
} = vi.hoisted(() => ({
  resolveBinding: vi.fn(),
  executeMapping: vi.fn(),
  filterClaims: vi.fn(async (input: { claims: Record<string, unknown> }) => input.claims),
  filterBaselineClaims: vi.fn((claims: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(claims).filter(
        ([key]) => key === 'sub' || key === 'iss' || key === 'email' || key.startsWith('::')
      )
    )
  ),
  loadDescriptor: vi.fn(),
  assertReleaseSafety: vi.fn(),
}));

vi.mock('../identity-mapping-runtime-resolver', () => ({
  resolveRuntimeIdentityMappingBinding: resolveBinding,
  assertRuntimeIdentityMappingReleaseSafety: assertReleaseSafety,
}));

vi.mock('@authrim/ar-lib-field-mapping/runtime', () => ({
  executeRuntimeMapping: executeMapping,
}));

vi.mock('../destination-profile-consent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../destination-profile-consent')>()),
  filterOidcClaimsByDestinationConsent: filterClaims,
  filterOidcClaimsWithoutDestinationProfile: filterBaselineClaims,
  loadDestinationProfileConsentDescriptor: loadDescriptor,
}));

import {
  applyOIDCIdentityMapping,
  deriveOIDCSubject,
  mappingSourceRefs,
  OIDCIdentityMappingRuntimeError,
} from '../oidc-identity-mapping';

const adapter = {} as DatabaseAdapter;
const adminAdapter = {
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
} as unknown as DatabaseAdapter;
const binding = {
  fieldMappingSetId: 'set-1',
  fieldMappingVersionId: 'version-1',
  destinationNamespace: 'oidc.claim',
  destinationProfileId: 'destination-profile-oidc',
  destinationProfileIds: ['destination-profile-oidc'],
  catalog: { entries: [] },
  edges: [],
  transforms: [],
  validationRules: [],
  fieldMappingSet: {},
};

describe('applyOIDCIdentityMapping fail-closed behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue(binding);
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
  });

  it('keeps standard claims but fails closed for extensions when no mapping or profile exists', async () => {
    resolveBinding.mockResolvedValue(null);
    const claims = {
      iss: 'https://issuer.example',
      sub: 'user-1',
      email: 'user@example.com',
      '::age_over_18': true,
      authrim_roles: ['admin'],
      user_type: 'anonymous',
      upgrade_eligible: true,
      department: 'Finance',
    };

    await expect(
      applyOIDCIdentityMapping({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims,
      })
    ).resolves.toEqual({
      claims: {
        iss: 'https://issuer.example',
        sub: 'user-1',
        email: 'user@example.com',
        '::age_over_18': true,
      },
      binding: null,
    });
  });

  it('resolves control-plane mappings from the dedicated Admin database when configured', async () => {
    const claims = { sub: 'user-1' };

    await applyOIDCIdentityMapping({
      adapter,
      env: { DB_ADMIN: adminAdapter as never },
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims,
    });

    expect(resolveBinding).toHaveBeenCalledWith(
      adminAdapter,
      expect.objectContaining({
        tenantId: 'tenant-a',
        protocol: 'oidc',
        role: 'op',
        clientId: 'client-a',
      })
    );
    expect(resolveBinding).not.toHaveBeenCalledWith(adapter, expect.anything());
  });

  it('exposes neutral display and picture aliases only to the mapping runtime', async () => {
    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: {
        sub: 'user-1',
        name: 'Ada Lovelace',
        picture: 'https://example.test/ada.png',
      },
    });

    expect(executeMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceValues: expect.arrayContaining([
          expect.objectContaining({
            value: 'Ada Lovelace',
            sourceRef: expect.objectContaining({ path: 'display_name' }),
          }),
          expect.objectContaining({
            value: 'https://example.test/ada.png',
            sourceRef: expect.objectContaining({ path: 'picture_url' }),
          }),
        ]),
      })
    );
    expect(filterClaims).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.not.objectContaining({
          display_name: expect.anything(),
          picture_url: expect.anything(),
        }),
      })
    );
  });

  it('fails closed when an explicitly selected policy binding is missing', async () => {
    resolveBinding.mockResolvedValue(null);

    await expect(
      applyOIDCIdentityMapping({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selector: { fieldMappingSetId: 'required-set' },
        claims: { sub: 'user-1' },
      })
    ).rejects.toMatchObject({
      name: 'OIDCIdentityMappingRuntimeError',
      details: {
        code: 'policy.missing_identity_mapping_binding',
        fieldMappingSetId: 'required-set',
        clientId: 'client-a',
      },
    });
  });

  it('propagates resolver errors only when the policy explicitly requires mapping', async () => {
    resolveBinding.mockRejectedValue(new Error('database unavailable'));

    await expect(
      applyOIDCIdentityMapping({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).resolves.toEqual({ claims: { sub: 'user-1' }, binding: null });

    await expect(
      applyOIDCIdentityMapping({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selector: { fieldMappingSetId: 'required-set' },
        claims: { sub: 'user-1' },
      })
    ).rejects.toThrow('database unavailable');
  });

  it('copies only values in the selected destination namespace', async () => {
    executeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          value: 'mapped@example.com',
        },
        { sourceRef: { side: 'source', namespace: 'oidc.claim', path: 'admin' }, value: true },
        {
          sourceRef: { side: 'destination', namespace: 'saml.attribute', path: 'admin' },
          value: true,
        },
      ],
    });

    const result = await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1', email: 'original@example.com' },
    });

    expect(result.claims).toEqual({ sub: 'user-1', email: 'mapped@example.com' });
    expect(result.claims).not.toHaveProperty('admin');
    expect(executeMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: {
          oidc: expect.objectContaining({ clientId: 'client-a', pairwiseSubject: 'user-1' }),
        },
      })
    );
  });

  it('preserves authorization-server protocol claims while allowing mapped profile claims', async () => {
    executeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'acr' },
          value: 'urn:attacker:gold',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'amr' },
          value: ['hwk'],
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'aud' },
          value: 'other-client',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sid' },
          value: 'other-session',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'cnf' },
          value: { jkt: 'attacker-thumbprint' },
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: 'pairwise-user-1',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
          value: 'mapped@example.com',
        },
      ],
    });

    const result = await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: {
        sub: 'user-1',
        acr: 'urn:authrim:silver',
        amr: ['pwd'],
        aud: 'client-a',
        sid: 'session-1',
        cnf: { jkt: 'legitimate-thumbprint' },
        email: 'original@example.com',
      },
    });

    expect(result.claims).toMatchObject({
      sub: 'pairwise-user-1',
      acr: 'urn:authrim:silver',
      amr: ['pwd'],
      aud: 'client-a',
      sid: 'session-1',
      cnf: { jkt: 'legitimate-thumbprint' },
      email: 'mapped@example.com',
    });
  });

  it('protects protocol claims when a tenant selects a custom destination namespace', async () => {
    resolveBinding.mockResolvedValue({ ...binding, destinationNamespace: 'custom' });
    executeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'custom', path: 'acr' },
          value: 'urn:attacker:gold',
        },
        {
          sourceRef: { side: 'destination', namespace: 'custom', path: 'aud' },
          value: 'other-client',
        },
        {
          sourceRef: { side: 'destination', namespace: 'custom', path: 'sub' },
          value: 'pairwise-user-1',
        },
        {
          sourceRef: { side: 'destination', namespace: 'custom', path: 'email' },
          value: 'mapped@example.com',
        },
      ],
    });

    const result = await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: {
        sub: 'user-1',
        acr: 'urn:authrim:silver',
        aud: 'client-a',
        email: 'original@example.com',
      },
    });

    expect(result.claims).toMatchObject({
      sub: 'pairwise-user-1',
      acr: 'urn:authrim:silver',
      aud: 'client-a',
      email: 'mapped@example.com',
    });
  });

  it('converts runtime validation failure into a stable policy error', async () => {
    executeMapping.mockReturnValue({ status: 'failed', values: [] });

    await expect(
      applyOIDCIdentityMapping({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<OIDCIdentityMappingRuntimeError>>({
        name: 'OIDCIdentityMappingRuntimeError',
        details: expect.objectContaining({
          code: 'policy.identity_mapping_failed',
          fieldMappingSetId: 'set-1',
          fieldMappingVersionId: 'version-1',
        }),
      })
    );
  });
});

describe('applyOIDCIdentityMapping source attributes', () => {
  const sourceEdge = (path: string) => ({
    id: `edge-${path}`,
    sourceRef: { side: 'source', namespace: 'oidc.claim', path },
    targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
  });
  const sourceValuesOfLastRun = () =>
    (
      executeMapping.mock.calls.at(-1)?.[0] as {
        sourceValues: Array<{ sourceRef: { path: string }; value: unknown }>;
      }
    ).sourceValues;

  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue({ ...binding, edges: [sourceEdge('preferred_username')] });
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
  });

  it("reads an attribute the mapping uses from the user's attributes when the claims lack it", async () => {
    const sourceAttributes = vi.fn(async () => ({
      preferred_username: 'alice',
      email: 'alice@example.com',
      phone_number: '+8100000000',
    }));

    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1', nonce: 'n' },
      sourceAttributes,
    });

    expect(sourceAttributes).toHaveBeenCalledTimes(1);
    expect(sourceAttributes).toHaveBeenCalledWith(['preferred_username']);
    const sources = sourceValuesOfLastRun();
    expect(sources).toContainEqual(
      expect.objectContaining({
        sourceRef: expect.objectContaining({ path: 'preferred_username' }),
        value: 'alice',
      })
    );
    // Only what the mapping reads is taken: nothing else of the user's is a source.
    expect(sources.map((source) => source.sourceRef.path).sort()).toEqual([
      'nonce',
      'preferred_username',
      'sub',
    ]);
  });

  it('derives the same mapping input whether or not the claims carry the attribute', async () => {
    const attributes = { preferred_username: 'alice' };

    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1', preferred_username: 'alice' },
      sourceAttributes: attributes,
    });
    const withClaim = sourceValuesOfLastRun().find(
      (source) => source.sourceRef.path === 'preferred_username'
    );
    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
      sourceAttributes: attributes,
    });
    const withoutClaim = sourceValuesOfLastRun().find(
      (source) => source.sourceRef.path === 'preferred_username'
    );

    expect(withClaim?.value).toBe('alice');
    expect(withoutClaim?.value).toBe('alice');
  });

  it('loads nothing when the claims already carry what the mapping reads', async () => {
    const sourceAttributes = vi.fn(async () => ({ preferred_username: 'other' }));

    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1', preferred_username: 'alice' },
      sourceAttributes,
    });

    expect(sourceAttributes).not.toHaveBeenCalled();
    expect(sourceValuesOfLastRun()).toContainEqual(
      expect.objectContaining({
        sourceRef: expect.objectContaining({ path: 'preferred_username' }),
        value: 'alice',
      })
    );
  });

  it('loads nothing when the mapping reads no source attribute, or there is no mapping', async () => {
    const sourceAttributes = vi.fn(async () => ({ preferred_username: 'alice' }));
    resolveBinding.mockResolvedValue({ ...binding, edges: [] });

    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
      sourceAttributes,
    });
    resolveBinding.mockResolvedValue(null);
    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
      sourceAttributes,
    });

    expect(sourceAttributes).not.toHaveBeenCalled();
  });

  it('never copies a source attribute into the output unless the mapping maps it', async () => {
    const result = await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
      sourceAttributes: { preferred_username: 'alice', email: 'alice@example.com' },
    });

    expect(result.claims).toEqual({ sub: 'user-1' });
  });

  it('derives the subject from the attributes for deriveOIDCSubject too', async () => {
    executeMapping.mockImplementation(
      (input: { sourceValues: Array<{ sourceRef: { path: string }; value: unknown }> }) => ({
        status: 'success',
        values: input.sourceValues
          .filter((source) => source.sourceRef.path === 'preferred_username')
          .map((source) => ({
            sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
            value: source.value,
          })),
      })
    );

    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
        sourceAttributes: async () => ({ preferred_username: 'alice' }),
      })
    ).resolves.toBe('alice');
  });
});

describe('mapping source references', () => {
  const sourceRef = (path: string, namespace = 'oidc.claim') => ({
    side: 'source' as const,
    namespace,
    path,
  });
  const requiredRule = (id: string, targetRef: ReturnType<typeof sourceRef> | object) => ({
    id,
    kind: 'required' as const,
    targetRef: targetRef as never,
    defaultSeverity: 'critical' as const,
  });

  it('lists the sources of the edges and the source fields the validation rules check, once each', () => {
    const refs = mappingSourceRefs({
      edges: [
        {
          id: 'e1',
          sourceRef: sourceRef('email'),
          targetRef: { side: 'destination', namespace: 'oidc.claim', path: 'email' },
        },
      ] as never,
      validationRules: [
        requiredRule('r1', sourceRef('preferred_username')),
        requiredRule('r2', sourceRef('email')),
        requiredRule('r3', { side: 'destination', namespace: 'oidc.claim', path: 'sub' }),
      ],
    });

    expect(refs.map((ref) => `${ref.namespace}:${ref.path}`)).toEqual([
      'oidc.claim:email',
      'oidc.claim:preferred_username',
    ]);
  });
});

describe('applyOIDCIdentityMapping validation-rule sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue({
      ...binding,
      edges: [],
      validationRules: [
        {
          id: 'rule-username-required',
          kind: 'required',
          targetRef: { side: 'source', namespace: 'oidc.claim', path: 'preferred_username' },
          defaultSeverity: 'critical',
        },
      ],
    });
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    loadDescriptor.mockResolvedValue({ destinationType: 'oidc', fields: [] });
  });

  it('loads an attribute only a validation rule reads, and hands it to the mapping', async () => {
    const sourceAttributes = vi.fn(async () => ({
      preferred_username: 'alice',
      email: 'alice@example.com',
    }));

    await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
      sourceAttributes,
    });

    expect(sourceAttributes).toHaveBeenCalledWith(['preferred_username']);
    const sources = (
      executeMapping.mock.calls.at(-1)?.[0] as {
        sourceValues: Array<{ sourceRef: { path: string }; value: unknown }>;
      }
    ).sourceValues;
    expect(sources).toContainEqual(
      expect.objectContaining({
        sourceRef: expect.objectContaining({ path: 'preferred_username' }),
        value: 'alice',
      })
    );
    expect(sources.map((source) => source.sourceRef.path)).not.toContain('email');
  });
});

describe('deriveOIDCSubject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveBinding.mockResolvedValue(binding);
    loadDescriptor.mockResolvedValue(null);
  });

  it('refuses a mapped sub in a client or admin principal namespace', async () => {
    executeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: 'client:alice',
        },
      ],
    });
    const mappingInput = {
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
    };

    await expect(applyOIDCIdentityMapping(mappingInput)).rejects.toMatchObject({
      details: { code: 'policy.identity_mapping_reserved_subject' },
    });
    await expect(deriveOIDCSubject(mappingInput)).rejects.toBeInstanceOf(
      OIDCIdentityMappingRuntimeError
    );
  });

  it('takes the mapped sub even when other fields fail validation, without release consent', async () => {
    executeMapping.mockReturnValue({
      status: 'failed',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: 'pairwise-1',
        },
      ],
    });

    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).resolves.toBe('pairwise-1');
    expect(filterClaims).not.toHaveBeenCalled();
  });

  it('takes the last sub, as issuance overwrites the edge output with the transform result', async () => {
    executeMapping.mockReturnValue({
      status: 'success',
      values: [
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: 'user-1',
        },
        {
          sourceRef: { side: 'destination', namespace: 'oidc.claim', path: 'sub' },
          value: 'pairwise-1',
        },
      ],
    });
    const issued = await applyOIDCIdentityMapping({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1' },
    });
    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).resolves.toBe(issued.claims.sub);
    expect(issued.claims.sub).toBe('pairwise-1');
  });

  it("maps from the user's claims it is given, as issuance does", async () => {
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    await deriveOIDCSubject({
      adapter,
      tenantId: 'tenant-a',
      clientId: 'client-a',
      claims: { sub: 'user-1', preferred_username: 'alice' },
    });
    expect(executeMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceValues: expect.arrayContaining([expect.objectContaining({ value: 'alice' })]),
      })
    );
  });

  it("keeps the user's id when the mapping issues no sub, or there is no mapping", async () => {
    executeMapping.mockReturnValue({ status: 'success', values: [] });
    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).resolves.toBe('user-1');

    resolveBinding.mockResolvedValue(null);
    await expect(
      deriveOIDCSubject({
        adapter,
        tenantId: 'tenant-a',
        clientId: 'client-a',
        claims: { sub: 'user-1' },
      })
    ).resolves.toBe('user-1');
    expect(filterBaselineClaims).not.toHaveBeenCalled();
  });
});
