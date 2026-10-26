import { describe, expect, it, vi } from 'vitest';
import type { Env, SAMLRequestData } from '@authrim/ar-lib-core';
import { getKeyManagerSecret, getSigningCertificate, getSigningKey } from '../../common/key-utils';
import { consumeStoredAuthnRequest, storeAuthnRequest } from '../sso-stored-request';
import { resolveSAMLPairwiseSecret } from '../subject';

describe('alternate SAML IdP runtime ports', () => {
  it('stores and consumes the post-login AuthnRequest once within its tenant and SP', async () => {
    let stored: SAMLRequestData | null = null;
    const store = vi.fn(
      async (input: { tenantId: string; spEntityId: string; request: SAMLRequestData }) => {
        stored = input.request;
      }
    );
    const consume = vi.fn(async (input: { tenantId: string; spEntityId: string }) => {
      if (input.tenantId !== 'tenant-a' || input.spEntityId !== 'https://sp.example') return null;
      const result = stored;
      stored = null;
      return result;
    });
    const env = { SAML_RUNTIME_PORTS: { requests: { store, consume } } } as unknown as Env;
    const request = {
      id: '_request-1',
      issueInstant: new Date().toISOString(),
      issuer: 'https://sp.example',
      destination: 'https://idp.example/saml/idp/sso',
    };

    await storeAuthnRequest(env, 'tenant-a', request, 'relay', undefined, 300);
    expect(store.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      spEntityId: request.issuer,
      request: {
        requestId: request.id,
        issuer: request.issuer,
        data: request,
        relayState: 'relay',
      },
    });
    await expect(
      consumeStoredAuthnRequest(env, 'tenant-b', request.id, request.issuer)
    ).rejects.toThrow('not found or already used');
    await expect(
      consumeStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer)
    ).resolves.toMatchObject({ requestId: request.id, data: request });
    await expect(
      consumeStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer)
    ).rejects.toThrow('not found or already used');
  });

  it('uses imported signing material and pairwise secret without a KeyManager binding', async () => {
    const getKey = vi.fn(async () => ({
      kid: 'imported-key',
      privateKeyPem: 'private-pem',
      publicKeyPem: 'public-pem',
      certificate: 'certificate-pem',
    }));
    const getSecret = vi.fn(async (input: { secretRef: string }) => ({
      secretRef: input.secretRef,
      active: { kid: 'pairwise-1', value: 'pairwise-secret', createdAt: 1 },
      updatedAt: 1,
    }));
    const env = { SAML_RUNTIME_PORTS: { signing: { getKey, getSecret } } } as unknown as Env;

    await expect(
      getSigningKey(env, 'tenant-a', { keyRef: 'tenant:tenant-a:saml:idp:signing' })
    ).resolves.toMatchObject({ kid: 'imported-key', privateKeyPem: 'private-pem' });
    await expect(
      getSigningCertificate(env, 'tenant-a', { keyRef: 'tenant:tenant-a:saml:idp:signing' })
    ).resolves.toBe('certificate-pem');
    await expect(resolveSAMLPairwiseSecret(env, 'tenant-a')).resolves.toBe('pairwise-secret');
    expect(getKey).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      keyRef: 'tenant:tenant-a:saml:idp:signing',
    });
    expect(getSecret).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      secretRef: 'tenant:tenant-a:saml:pairwise-nameid',
    });
    await expect(
      getKeyManagerSecret(env, 'tenant-a', { secretRef: 'tenant:tenant-a:saml:pairwise-nameid' })
    ).resolves.toMatchObject({ active: { value: 'pairwise-secret' } });
  });
});
