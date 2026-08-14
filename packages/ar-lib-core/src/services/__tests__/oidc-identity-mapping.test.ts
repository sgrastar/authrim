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
