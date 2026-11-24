import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({ findByClientId: vi.fn() }));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  getTenantIdFromContext: () => 'tenant-1',
  createAuthContextFromHono: () => ({
    repositories: { client: { findByClientId: mocks.findByClientId } },
  }),
  // Any secret matches the recorded one: only the registered method can refuse the client.
  verifyClientSecretHash: async () => true,
}));

// The handler's issuer comes from the tenant the request context settled on.
vi.mock('../issuer', () => ({ getRequestIssuer: () => 'https://issuer.example' }));

import { backChannelLogoutHandler } from '../logout';

const env = { ISSUER_URL: 'https://issuer.example', KEY_MANAGER: undefined } as unknown as Env;

function request(clientId: string) {
  const app = new Hono<{ Bindings: Env }>();
  app.post('/logout/backchannel', backChannelLogoutHandler);
  return app.request(
    '/logout/backchannel',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:any-secret`)}`,
      },
      body: new URLSearchParams({ logout_token: 'a.b.c' }).toString(),
    },
    env
  );
}

describe('back-channel logout and a wallet attestation client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['with a recorded secret', { client_secret_hash: 'recorded-hash' }],
    ['without a secret', {}],
  ] as const)('does not authenticate it %s', async (_name, stored) => {
    mocks.findByClientId.mockResolvedValue({
      client_id: 'wallet-1',
      token_endpoint_auth_method: 'attest_jwt_client_auth',
      ...stored,
    });

    const response = await request('wallet-1');

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'invalid_client',
      error_description: 'Invalid client credentials',
    });
  });

  it('still authenticates a client of another method by its secret', async () => {
    mocks.findByClientId.mockResolvedValue({
      client_id: 'rp-1',
      token_endpoint_auth_method: 'client_secret_basic',
      client_secret_hash: 'recorded-hash',
    });

    const response = await request('rp-1');

    // Past client authentication, the (made up) logout token is what fails.
    const body: { error_description?: string } = await response.json();
    expect(body.error_description).not.toBe('Invalid client credentials');
  });
});
