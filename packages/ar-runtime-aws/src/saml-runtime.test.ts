import { generateKeyPairSync, X509Certificate } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthRuntimePorts } from '@authrim/ar-lib-core/types/auth-runtime-ports';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import { generateSelfSignedCertificate } from '../../ar-saml/src/common/key-utils';
import { createSAMLRuntimePorts, createSAMLTransientStateKV } from './saml-runtime';
import type { PostgresTransientStateStore } from './storage/postgres-transient-state';

function fakeState() {
  return {
    storeSamlRequest: vi.fn(async () => undefined),
    consumeSamlRequest: vi.fn(async () => null),
    putKey: vi.fn(async () => undefined),
    getKey: vi.fn(async () => 'stored'),
    deleteKey: vi.fn(async () => true),
  };
}

function fakeAuthSessions(tenantId = 'alpha') {
  const getSessionRpc = vi.fn(async () => ({
    id: 'session-1',
    tenantId,
    userId: 'user-1',
    createdAt: 1234,
    data: { amr: ['passkey'] },
  }));
  const sessions = {
    newSessionId: () => 'session-1',
    forSession: vi.fn(() => ({ getSessionRpc })),
  } as unknown as AuthRuntimePorts['sessions'];
  return { sessions, getSessionRpc };
}

async function signingFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJWK = publicKey.export({ format: 'jwk' });
  const certificate = await generateSelfSignedCertificate(publicJWK, privateKeyPem);
  const certificateSha256Thumbprint = new X509Certificate(certificate).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();
  return {
    tenantId: 'alpha',
    keys: [
      {
        keyRef: 'tenant:alpha:saml:idp:signing',
        kid: 'key-1',
        privateKeyPem,
        publicJWK,
        certificate,
        certificateSha256Thumbprint,
      },
    ],
  };
}

function pairwiseSecret(tenantId = 'alpha') {
  return {
    tenantId,
    secretRef: `tenant:${tenantId}:saml:pairwise-nameid`,
    active: { kid: 'salt-1', value: 'imported-secret', createdAt: 1234 },
    updatedAt: 1234,
  };
}

const SERVICE_PROVIDERS = [{ tenantId: 'alpha', entityIds: ['https://sp.example.test/idp'] }];
const SERVICE_PROVIDER_RELEASES: SAMLRuntimeImportedSPRelease[] = [
  {
    tenantId: 'alpha',
    entityId: 'https://sp.example.test/idp',
    sourceSelector: null,
    sourceBindingRef: {
      activationId: 'activation-1',
      fieldMappingSetId: 'set-1',
      fieldMappingVersionId: 'version-1',
      mappingSnapshotHash: 'snapshot-1',
      destinationProfileId: 'profile-1',
      destinationProfileVersionId: 'profile-version-1',
    },
    binding: {},
    destinationProfile: {
      profileId: 'profile-1',
      profileVersionId: 'profile-version-1',
      destinationType: 'saml',
      fields: [],
    },
  },
];

describe('AWS SAML runtime composition', () => {
  it('uses imported matching signing material and tenant-scoped session state', async () => {
    const state = fakeState();
    const auth = fakeAuthSessions();
    const bundle = await signingFixture();
    const ports = createSAMLRuntimePorts({
      state: state as unknown as PostgresTransientStateStore,
      authSessions: auth.sessions,
      signingBundles: [bundle],
      secrets: [pairwiseSecret()],
      serviceProviders: SERVICE_PROVIDERS,
      serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
    });

    expect(
      ports.serviceProviders.isAllowed({
        tenantId: 'alpha',
        entityId: 'https://sp.example.test/idp',
      })
    ).toBe(true);
    expect(
      ports.serviceProviders.isAllowed({
        tenantId: 'beta',
        entityId: 'https://sp.example.test/idp',
      })
    ).toBe(false);
    expect(
      ports.serviceProviders.isAllowed({
        tenantId: 'alpha',
        entityId: 'https://other.example.test/idp',
      })
    ).toBe(false);

    expect((await ports.signing.getKey({ tenantId: 'alpha' })).kid).toBe('key-1');
    await expect(ports.signing.getKey({ tenantId: 'beta' })).rejects.toThrow('unavailable');
    await expect(
      ports.signing.getSecret({
        tenantId: 'beta',
        secretRef: 'tenant:alpha:saml:pairwise-nameid',
      })
    ).rejects.toThrow('tenant-scoped');
    expect((await ports.sessions.get({ tenantId: 'alpha', sessionId: 'session-1' }))?.data).toEqual(
      {
        amr: ['passkey'],
      }
    );
    expect(auth.getSessionRpc).toHaveBeenCalledWith('session-1');
  });

  it('refuses a session returned under another tenant', async () => {
    const ports = createSAMLRuntimePorts({
      state: fakeState() as unknown as PostgresTransientStateStore,
      authSessions: fakeAuthSessions('beta').sessions,
      signingBundles: [await signingFixture()],
      secrets: [pairwiseSecret()],
      serviceProviders: SERVICE_PROVIDERS,
      serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
    });
    await expect(ports.sessions.get({ tenantId: 'alpha', sessionId: 'session-1' })).rejects.toThrow(
      'session binding invalid'
    );
  });

  it('rejects mismatched certificate fingerprint and missing imported keys', async () => {
    const bundle = await signingFixture();
    bundle.keys[0].certificateSha256Thumbprint = '00'.repeat(32);
    expect(() =>
      createSAMLRuntimePorts({
        state: fakeState() as unknown as PostgresTransientStateStore,
        authSessions: fakeAuthSessions().sessions,
        signingBundles: [bundle],
        secrets: [pairwiseSecret()],
        serviceProviders: SERVICE_PROVIDERS,
        serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
      })
    ).toThrow('thumbprint');

    const validBundle = await signingFixture();
    const ports = createSAMLRuntimePorts({
      state: fakeState() as unknown as PostgresTransientStateStore,
      authSessions: fakeAuthSessions().sessions,
      signingBundles: [validBundle],
      secrets: [pairwiseSecret()],
      serviceProviders: SERVICE_PROVIDERS,
      serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
    });
    await expect(
      ports.signing.getKey({ tenantId: 'alpha', keyRef: 'tenant:alpha:saml:idp:other' })
    ).rejects.toThrow('unavailable');
    expect(() =>
      createSAMLRuntimePorts({
        state: fakeState() as unknown as PostgresTransientStateStore,
        authSessions: fakeAuthSessions().sessions,
        signingBundles: [validBundle],
        secrets: [],
        serviceProviders: SERVICE_PROVIDERS,
        serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
      })
    ).toThrow('pairwise NameID secret');
    expect(() =>
      createSAMLRuntimePorts({
        state: fakeState() as unknown as PostgresTransientStateStore,
        authSessions: fakeAuthSessions().sessions,
        signingBundles: [validBundle],
        secrets: [pairwiseSecret()],
        serviceProviders: [],
        serviceProviderReleases: SERVICE_PROVIDER_RELEASES,
      })
    ).toThrow('service provider inventory');
  });

  it('requires tenant-scoped transient keys and explicit TTL', async () => {
    const state = fakeState();
    const kv = createSAMLTransientStateKV(state as unknown as PostgresTransientStateStore);
    await kv.put('saml:session-index:tenant:alpha:sp:publisher:id:session', 'value', {
      expirationTtl: 300,
    });
    expect(state.putKey).toHaveBeenCalledWith({
      tenantId: 'alpha',
      key: 'saml:session-index:tenant:alpha:sp:publisher:id:session',
      value: 'value',
      ttlMs: 300_000,
    });
    await expect(kv.put('saml:session-index:tenant:alpha:id:x', 'value')).rejects.toThrow(
      'expirationTtl'
    );
    await expect(kv.get('saml:session-index:unscoped')).rejects.toThrow('tenant-scoped');
  });
});
