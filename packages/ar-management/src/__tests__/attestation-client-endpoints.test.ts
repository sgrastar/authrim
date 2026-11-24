import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';

const mocks = vi.hoisted(() => ({
  findByClientId: vi.fn(),
  revokeToken: vi.fn(async () => {}),
  verifyToken: vi.fn(async () => ({})),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@authrim/ar-lib-core')>()),
  validateClientId: () => ({ valid: true }),
  // Any secret matches the recorded one: only the registered method can refuse the client.
  verifyClientSecretHash: async () => true,
  getTenantIdFromContext: () => 'tenant-1',
  createAuthContextFromHono: () => ({
    repositories: { client: { findByClientId: mocks.findByClientId } },
  }),
  revokeToken: mocks.revokeToken,
  verifyToken: mocks.verifyToken,
}));
vi.mock('../request-issuer', () => ({
  getRequestAwareIssuerUrl: () => 'https://issuer.example',
}));

import { batchRevokeHandler, revokeHandler } from '../revoke';
import { introspectHandler } from '../introspect';

const env = { DB: {}, KV: { get: async () => null } } as unknown as Env;

function app() {
  const hono = new Hono<{ Bindings: Env }>();
  hono.post('/revoke', revokeHandler);
  hono.post('/revoke/batch', batchRevokeHandler);
  hono.post('/introspect', introspectHandler);
  return hono;
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

describe('wallet attestation clients at the endpoints that do not verify an attestation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Registered for attestation, with a secret recorded or without one (read as a public client).
  const clients = [
    ['with a recorded secret', { client_secret_hash: 'recorded-hash' }],
    ['without a secret', {}],
  ] as const;

  describe.each(clients)('%s', (_name, stored) => {
    beforeEach(() => {
      mocks.findByClientId.mockResolvedValue({
        client_id: 'wallet-1',
        token_endpoint_auth_method: 'attest_jwt_client_auth',
        ...stored,
      });
    });

    it('is not authenticated for revocation', async () => {
      const response = await app().request(
        '/revoke',
        form({ token: 'a.b.c', client_id: 'wallet-1', client_secret: 'any-secret' }),
        env
      );
      expect(response.status).toBe(401);
      expect(mocks.revokeToken).not.toHaveBeenCalled();
    });

    it('is not authenticated for batch revocation', async () => {
      const response = await app().request(
        '/revoke/batch',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${btoa('wallet-1:any-secret')}`,
          },
          body: JSON.stringify({ tokens: [{ token: 'a.b.c' }] }),
        },
        env
      );
      expect(response.status).toBe(401);
      expect(mocks.revokeToken).not.toHaveBeenCalled();
    });

    it('is not authenticated for introspection', async () => {
      const response = await app().request(
        '/introspect',
        form({ token: 'a.b.c', client_id: 'wallet-1', client_secret: 'any-secret' }),
        env
      );
      expect(response.status).toBe(401);
      expect(mocks.verifyToken).not.toHaveBeenCalled();
    });
  });
});
