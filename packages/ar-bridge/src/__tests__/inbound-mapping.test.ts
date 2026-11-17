import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIdentityMappingBinding } from '@authrim/ar-lib-core/services/identity-mapping-runtime-resolver';
import {
  defaultInboundSources,
  inboundProfileTargets,
} from '@authrim/ar-lib-core/services/inbound-identity-mapping';
import { withRequestEnvironment } from './inbound-request-environment';
import type { UpstreamProvider } from '../types';
import { mapOIDCInboundUserInfo, oidcInboundMappingSelector } from '../services/inbound-mapping';

const mocks = vi.hoisted(() => ({ binding: vi.fn(), custom: vi.fn() }));
vi.mock('@authrim/ar-lib-core', async (original) => ({
  ...(await original<typeof import('@authrim/ar-lib-core')>()),
  requireDedicatedAdminDatabaseAdapter: () => ({}),
  resolveAuthCorePersistenceAdapterFromEnv: async () => ({}),
}));
vi.mock('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver', async (original) => ({
  ...(await original<
    typeof import('@authrim/ar-lib-core/services/identity-mapping-runtime-resolver')
  >()),
  resolveRuntimeIdentityMappingBinding: mocks.binding,
  loadCustomClaimSchemaCatalogEntries: mocks.custom,
}));
function provider(): UpstreamProvider {
  return {
    createdAt: 1,
    updatedAt: 1,
    id: 'synthetic-op',
    tenantId: 'synthetic-tenant',
    providerType: 'oidc',
    name: 'Synthetic OP',
    enabled: true,
    priority: 0,
    clientId: 'synthetic-client',
    clientSecretEncrypted: '',
    scopes: 'openid email profile',
    attributeMapping: { name: 'old_name', 'custom_claims.stale': 'old_claim' },
    autoLinkEmail: false,
    jitProvisioning: false,
    requireEmailVerified: true,
    trustEmail: false,
    providerQuirks: {
      inboundIdentityMapping: { fieldMappingSetId: 'set', fieldMappingVersionId: 'version' },
    },
  };
}
function binding(): RuntimeIdentityMappingBinding {
  const targetRef = { namespace: 'authrim.profile', path: 'email' };
  const rule: NonNullable<RuntimeIdentityMappingBinding['graphRules']>[number] = {
    id: 'email',
    targetRef: { side: 'destination', ...targetRef },
    edges: [
      {
        id: 'email-source',
        sourceRef: { side: 'source', namespace: 'oidc.userinfo', path: 'email' },
        targetRef: { side: 'destination', ...targetRef },
      },
    ],
    transforms: [{ id: 'trim', operation: 'trim', inputs: [{ edgeIndex: 0 }] }],
    output: { stepIndex: 0 },
  };
  return {
    id: 'activation',
    tenantId: 'synthetic-tenant',
    fieldMappingSetId: 'set',
    fieldMappingVersionId: 'version',
    mappingSnapshotHash: 'snapshot',
    catalog: {
      identity: { id: 'catalog', version: '1', contentHash: 'synthetic', compatibilityRange: '*' },
      entries: [...defaultInboundSources('oidc'), ...inboundProfileTargets()],
    },
    graphRules: [rule],
    edges: [],
    transforms: [],
    validationRules: [],
    fieldMappingSet: { id: 'version', rules: [] },
    activationScope: {
      protocol: 'oidc',
      role: 'rp',
      providerId: 'synthetic-op',
      inboundContract: 'connection-v1',
    },
    destinationProfileIds: [],
  };
}
beforeEach(() => {
  mocks.binding.mockResolvedValue(binding());
  mocks.custom.mockResolvedValue([]);
});
describe('actual OIDC receiver projection', () => {
  it('preserves validated identity/authentication evidence and drops stale legacy/raw projections', async () =>
    withRequestEnvironment(async (env) => {
      const result = await mapOIDCInboundUserInfo(env, 'synthetic-tenant', provider(), {
        sub: 'immutable-sub',
        email: ' sample@example.test ',
        email_verified: true,
        name: 'Raw name',
        old_name: 'Old mapping',
        old_claim: 'Old custom mapping',
        acr: 'synthetic-acr',
        auth_time: 100,
        amr: ['pwd'],
      });
      expect(result).toEqual({
        userInfo: {
          sub: 'immutable-sub',
          email: 'sample@example.test',
          email_verified: false,
          acr: 'synthetic-acr',
          auth_time: 100,
          amr: ['pwd'],
        },
        customClaims: {},
      });
      expect(mocks.binding).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'synthetic-tenant',
          role: 'rp',
          providerId: 'synthetic-op',
          fieldMappingVersionId: 'version',
        })
      );
    }));
  it('retains verified email only when the mapped address is exactly the verified incoming address', async () =>
    withRequestEnvironment(async (env) => {
      const result = await mapOIDCInboundUserInfo(env, 'synthetic-tenant', provider(), {
        sub: 'immutable-sub',
        email: 'sample@example.test',
        email_verified: true,
      });
      expect(result?.userInfo.email_verified).toBe(true);
    }));
  it('leaves unconfigured legacy handling untouched without resolving a graph', async () =>
    withRequestEnvironment(async (env) => {
      const value = provider();
      value.providerQuirks = {};
      mocks.binding.mockClear();
      expect(
        await mapOIDCInboundUserInfo(env, 'synthetic-tenant', value, {
          sub: 'legacy-sub',
        })
      ).toBeUndefined();
      expect(mocks.binding).not.toHaveBeenCalled();
    }));
  it('fails configured inactive, malformed, wrong-tenant and protected-target graphs', async () =>
    withRequestEnvironment(async (env) => {
      mocks.binding.mockResolvedValueOnce(null);
      await expect(
        mapOIDCInboundUserInfo(env, 'synthetic-tenant', provider(), { sub: 'immutable-sub' })
      ).rejects.toThrow('not_active');
      expect(() => oidcInboundMappingSelector({ inboundIdentityMapping: null })).toThrow(
        'binding_invalid'
      );
      await expect(
        mapOIDCInboundUserInfo(env, 'different-tenant', provider(), { sub: 'immutable-sub' })
      ).rejects.toThrow('provider_invalid');
      const invalid = binding();
      if (!invalid.graphRules) throw new Error('Missing fixture graph');
      invalid.graphRules[0].targetRef.path = 'sub';
      mocks.binding.mockResolvedValueOnce(invalid);
      await expect(
        mapOIDCInboundUserInfo(env, 'synthetic-tenant', provider(), { sub: 'immutable-sub' })
      ).rejects.toThrow();
    }));
});
