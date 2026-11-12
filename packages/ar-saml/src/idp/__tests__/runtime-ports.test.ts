import { describe, expect, it, vi } from 'vitest';
import type { Env, SAMLRequestContext, SAMLRequestData } from '@authrim/ar-lib-core';
import { getKeyManagerSecret, getSigningCertificate, getSigningKey } from '../../common/key-utils';
import {
  completeStoredAuthnRequest,
  readStoredAuthnRequest,
  saveStoredAuthnRequest,
} from '../sso-stored-request';
import { resolveSAMLPairwiseSecret } from '../subject';

describe('alternate SAML IdP runtime ports', () => {
  it('creates, reads, updates and completes the AuthnRequest within its tenant and SP', async () => {
    let stored: SAMLRequestData | null = null;
    const forThisRequest = (input: { tenantId: string; spEntityId: string }) =>
      input.tenantId === 'tenant-a' && input.spEntityId === 'https://sp.example';
    const create = vi.fn(
      async (input: { tenantId: string; spEntityId: string; request: SAMLRequestData }) => {
        if (stored) return false;
        stored = { ...input.request, revision: 1 };
        return true;
      }
    );
    const read = vi.fn(async (input: { tenantId: string; spEntityId: string }) =>
      forThisRequest(input) ? stored : null
    );
    const update = vi.fn(
      async (input: {
        tenantId: string;
        spEntityId: string;
        expectedRevision: number;
        context: SAMLRequestContext;
      }) => {
        if (!forThisRequest(input) || !stored || stored.revision !== input.expectedRevision) {
          return null;
        }
        stored = { ...stored, context: input.context, revision: input.expectedRevision + 1 };
        return stored;
      }
    );
    const complete = vi.fn(
      async (input: { tenantId: string; spEntityId: string; expectedRevision?: number }) => {
        if (!forThisRequest(input) || !stored) return null;
        if (input.expectedRevision !== undefined && stored.revision !== input.expectedRevision) {
          return null;
        }
        const result = stored;
        stored = null;
        return result;
      }
    );
    const env = {
      SAML_RUNTIME_PORTS: { requests: { create, read, update, complete } },
    } as unknown as Env;
    const request = {
      id: '_request-1',
      issueInstant: new Date().toISOString(),
      issuer: 'https://sp.example',
      destination: 'https://idp.example/saml/idp/sso',
    };

    await saveStoredAuthnRequest(env, 'tenant-a', {
      authnRequest: request,
      relayState: 'relay',
      context: {},
      requestTtlSeconds: 300,
    });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      spEntityId: request.issuer,
      request: {
        requestId: request.id,
        issuer: request.issuer,
        data: request,
        relayState: 'relay',
        revision: 1,
      },
    });

    // The same request again is a replay.
    await expect(
      saveStoredAuthnRequest(env, 'tenant-a', {
        authnRequest: request,
        context: {},
        requestTtlSeconds: 300,
      })
    ).rejects.toThrow('already received');

    // Reading does not use it up, and is bound to the tenant and SP.
    await expect(
      readStoredAuthnRequest(env, 'tenant-b', request.id, request.issuer)
    ).rejects.toThrow('not found or already used');
    for (let i = 0; i < 2; i++) {
      await expect(
        readStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer)
      ).resolves.toMatchObject({ requestId: request.id, data: request, revision: 1 });
    }

    // An update goes by revision: a stale one changes nothing.
    await expect(
      saveStoredAuthnRequest(env, 'tenant-a', {
        authnRequest: request,
        context: { loginNonceHash: 'h' },
        storedRevision: 7,
      })
    ).rejects.toThrow('not found or already used');
    await expect(
      saveStoredAuthnRequest(env, 'tenant-a', {
        authnRequest: request,
        context: { loginNonceHash: 'h' },
        storedRevision: 1,
      })
    ).resolves.toMatchObject({ revision: 2, context: { loginNonceHash: 'h' } });
    expect(update).toHaveBeenLastCalledWith({
      tenantId: 'tenant-a',
      spEntityId: request.issuer,
      requestId: request.id,
      expectedRevision: 1,
      context: { loginNonceHash: 'h' },
    });

    // Completing uses it up once, at the revision it is at.
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer, {
        expectedRevision: 1,
      })
    ).rejects.toThrow('not found or already used');
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer, {
        expectedRevision: 2,
      })
    ).resolves.toMatchObject({ requestId: request.id, data: request });
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer, {
        expectedRevision: 2,
      })
    ).rejects.toThrow('not found or already used');
    await expect(
      readStoredAuthnRequest(env, 'tenant-a', request.id, request.issuer)
    ).rejects.toThrow('not found or already used');
  });

  it('passes the login nonce hash to the request port for a conditional complete', async () => {
    const complete = vi.fn(async () => null);
    const env = { SAML_RUNTIME_PORTS: { requests: { complete } } } as unknown as Env;
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', '_request-1', 'https://sp.example', {
        loginNonceHash: 'a'.repeat(64),
      })
    ).rejects.toThrow('not found or already used');
    expect(complete).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example',
      requestId: '_request-1',
      loginNonceHash: 'a'.repeat(64),
    });
    await expect(
      completeStoredAuthnRequest(env, 'tenant-a', '_request-1', 'https://sp.example')
    ).rejects.toThrow('not found or already used');
    expect(complete).toHaveBeenLastCalledWith({
      tenantId: 'tenant-a',
      spEntityId: 'https://sp.example',
      requestId: '_request-1',
    });
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
