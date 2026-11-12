/**
 * SAMLRequestStore: the IdP's AuthnRequest lifecycle (create once, read without using up, update
 * at a revision, complete once, keep the id until the request could no longer be accepted), on
 * the real Durable Object with in-memory storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMLRequestStore } from '../SAMLRequestStore';
import type { Env } from '../../types/env';
import type { SAMLRequestData } from '../../types/saml';

const SP = 'https://sp.example.com';
const NOW = Date.parse('2026-11-13T00:00:00Z');

function memoryState() {
  const data = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => structuredClone(data.get(key)),
      put: async (key: string, value: unknown) => {
        data.set(key, structuredClone(value));
      },
    },
  } as unknown as DurableObjectState;
}

function request(overrides: Partial<SAMLRequestData> = {}): SAMLRequestData {
  return {
    requestId: '_request-1',
    issuer: SP,
    destination: 'https://idp.example.com/saml/idp/sso',
    acsUrl: `${SP}/acs`,
    binding: 'post',
    type: 'authn_request',
    data: {
      id: '_request-1',
      issueInstant: new Date(NOW).toISOString(),
      issuer: SP,
      forceAuthn: false,
      isPassive: false,
    },
    relayState: 'relay',
    context: { loginNonceHash: 'hash-1' },
    used: false,
    createdAt: NOW,
    expiresAt: NOW + 5 * 60_000,
    retainUntil: NOW + 6 * 60_000,
    ...overrides,
  };
}

describe('SAMLRequestStore AuthnRequest lifecycle', () => {
  let store: SAMLRequestStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    store = new SAMLRequestStore(memoryState(), {} as Env);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores a request once at revision 1 and refuses the same id again', async () => {
    await expect(store.createAuthnRequest(SP, request())).resolves.toBe(true);
    await expect(store.createAuthnRequest(SP, request({ relayState: 'other' }))).resolves.toBe(
      false
    );
    await expect(store.readAuthnRequest('_request-1', SP)).resolves.toMatchObject({
      revision: 1,
      relayState: 'relay',
      used: false,
    });
  });

  it('reads without using the request up, and only for its SP', async () => {
    await store.createAuthnRequest(SP, request());
    await store.readAuthnRequest('_request-1', SP);
    await expect(store.readAuthnRequest('_request-1', SP)).resolves.not.toBeNull();
    await expect(store.readAuthnRequest('_request-1', 'https://other.example')).resolves.toBeNull();
  });

  it('updates the context only at the revision it was read at', async () => {
    await store.createAuthnRequest(SP, request());
    const updated = await store.updateAuthnRequest('_request-1', SP, 1, { sentToSignInAt: NOW });
    expect(updated).toMatchObject({ revision: 2, context: { sentToSignInAt: NOW } });
    // Another tab still holding revision 1.
    await expect(
      store.updateAuthnRequest('_request-1', SP, 1, { sentToSignInAt: NOW + 1 })
    ).resolves.toBeNull();
    await expect(store.readAuthnRequest('_request-1', SP)).resolves.toMatchObject({
      revision: 2,
      context: { sentToSignInAt: NOW },
      expiresAt: NOW + 5 * 60_000,
    });
  });

  it('completes once, and not at a stale revision', async () => {
    await store.createAuthnRequest(SP, request());
    await store.updateAuthnRequest('_request-1', SP, 1, {});
    await expect(
      store.completeAuthnRequest('_request-1', SP, { expectedRevision: 1 })
    ).resolves.toBeNull();
    await expect(
      store.completeAuthnRequest('_request-1', SP, { expectedRevision: 2 })
    ).resolves.toMatchObject({ used: true, revision: 2 });
    await expect(store.completeAuthnRequest('_request-1', SP)).resolves.toBeNull();
    await expect(store.readAuthnRequest('_request-1', SP)).resolves.toBeNull();
    await expect(store.updateAuthnRequest('_request-1', SP, 2, {})).resolves.toBeNull();
  });

  it('completes a login cancel only with the nonce hash the request was sent with', async () => {
    await store.createAuthnRequest(SP, request());
    await expect(
      store.completeAuthnRequest('_request-1', SP, { loginNonceHash: 'hash-other' })
    ).resolves.toBeNull();
    await expect(store.readAuthnRequest('_request-1', SP)).resolves.not.toBeNull();
    await expect(
      store.completeAuthnRequest('_request-1', SP, { loginNonceHash: 'hash-1' })
    ).resolves.not.toBeNull();
  });

  it('keeps an answered or expired request id until it could no longer be accepted', async () => {
    await store.createAuthnRequest(SP, request());
    await store.completeAuthnRequest('_request-1', SP);
    await expect(store.createAuthnRequest(SP, request())).resolves.toBe(false);

    await store.createAuthnRequest(SP, request({ requestId: '_request-2' }));
    vi.setSystemTime(NOW + 5 * 60_000 + 1); // expired, still retained
    await expect(store.readAuthnRequest('_request-2', SP)).resolves.toBeNull();
    await expect(store.completeAuthnRequest('_request-2', SP)).resolves.toBeNull();
    await expect(
      store.createAuthnRequest(
        SP,
        request({
          requestId: '_request-2',
          expiresAt: NOW + 10 * 60_000,
          retainUntil: NOW + 11 * 60_000,
        })
      )
    ).resolves.toBe(false);
  });

  it('refuses a request without a retention, or one that would wait too long', async () => {
    await expect(
      store.createAuthnRequest(SP, request({ retainUntil: undefined }))
    ).rejects.toThrow();
    await expect(
      store.createAuthnRequest(SP, request({ retainUntil: NOW + 60_000 }))
    ).rejects.toThrow();
    await expect(
      store.createAuthnRequest(
        SP,
        request({ expiresAt: NOW + 31 * 60_000, retainUntil: NOW + 32 * 60_000 })
      )
    ).rejects.toThrow();
    await expect(store.createAuthnRequest('https://other.example', request())).rejects.toThrow();
  });

  it('answers the lifecycle over its fetch endpoints', async () => {
    const call = (operation: string, body: Record<string, unknown>) =>
      store.fetch(
        new Request(`https://saml-request-store/authn/${operation}`, {
          method: 'POST',
          body: JSON.stringify({ spEntityId: SP, ...body }),
        })
      );
    expect((await call('create', { request: request() })).status).toBe(201);
    expect((await call('create', { request: request() })).status).toBe(409);
    expect((await call('read', { requestId: '_request-1' })).status).toBe(200);
    expect(
      (await call('update', { requestId: '_request-1', expectedRevision: 1, context: {} })).status
    ).toBe(200);
    expect((await call('complete', { requestId: '_request-1', expectedRevision: 1 })).status).toBe(
      409
    );
    expect((await call('complete', { requestId: '_request-1', expectedRevision: 2 })).status).toBe(
      200
    );
    expect((await call('read', { requestId: '_request-1' })).status).toBe(404);
  });
});
