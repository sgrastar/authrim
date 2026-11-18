import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair } from 'jose';
import type { Env } from '../../types/env';
import { createAccessToken } from '../jwt';
import { introspectTokenFromContext } from '../token-introspection';

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  resolveAccount: vi.fn(),
  findWithdrawal: vi.fn(),
  createAccountAuthContext: vi.fn(() => ({ coreAdapter: {} })),
}));

vi.mock('../request-cache', async (original) => ({
  ...(await original<typeof import('../request-cache')>()),
  getClientCached: mocks.client,
}));

vi.mock('../../services/runtime-data-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/runtime-data-context')>()),
  resolveAccountDataContextFromHono: mocks.resolveAccount,
}));
vi.mock('../../context/hono-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context/hono-context')>()),
  createAccountAuthContextFromHono: mocks.createAccountAuthContext,
}));
vi.mock('../../services/oauth-client-consent-revocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/oauth-client-consent-revocation')>()),
  findOAuthClientConsentRevocation: mocks.findWithdrawal,
}));

describe('protected-resource consent withdrawal', () => {
  let env: Env;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    env = {
      ISSUER_URL: 'https://issuer.example',
      PUBLIC_JWK_JSON: JSON.stringify(await exportJWK(keys.publicKey)),
      KEY_ID: 'consent-test-key',
      REVOKED_TOKENS: { get: vi.fn(async () => null) },
    } as unknown as Env;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.mockResolvedValue({ client_id: 'client-a', enabled: true });
    mocks.findWithdrawal.mockResolvedValue({ generation: 1, revokedAt: null });
  });

  async function inspect(claims: Record<string, unknown>) {
    const token = await createAccessToken(
      {
        iss: 'https://issuer.example',
        sub: 'user-a',
        aud: 'https://issuer.example',
        scope: 'openid',
        client_id: 'client-a',
        ...claims,
      },
      privateKey,
      'consent-test-key',
      300
    );
    const app = new Hono<{ Bindings: Env; Variables: { tenantId: string } }>();
    app.use('*', async (c, next) => {
      c.set('tenantId', 'tenant-a');
      await next();
    });
    app.get('/resource', async (c) => {
      const result = await introspectTokenFromContext(c);
      return c.json(result);
    });
    const response = await app.request(
      '/resource',
      { headers: { Authorization: `Bearer ${token.token}` } },
      env
    );
    return response.json<{
      valid: boolean;
      error?: { error: string; statusCode: number };
    }>();
  }

  it('rejects a user token after its consent generation is withdrawn', async () => {
    mocks.findWithdrawal.mockResolvedValue({ generation: 2, revokedAt: Date.now() });
    const result = await inspect({ authrim_consent_generation: 1 });
    expect(result).toMatchObject({
      valid: false,
      error: { error: 'invalid_token', statusCode: 401 },
    });
    expect(mocks.resolveAccount).toHaveBeenCalledWith(expect.anything(), 'user-a');
    expect(mocks.findWithdrawal).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      userId: 'user-a',
      clientId: 'client-a',
    });
  });

  it('accepts the current consent generation', async () => {
    expect(await inspect({ authrim_consent_generation: 1 })).toMatchObject({ valid: true });
  });

  it('fails closed when consent state cannot be read', async () => {
    mocks.findWithdrawal.mockRejectedValue(new Error('database unavailable'));
    expect(await inspect({ authrim_consent_generation: 1 })).toMatchObject({
      valid: false,
      error: { error: 'temporarily_unavailable', statusCode: 503 },
    });
  });

  it.each(['user-a', 'client-a'])(
    'rejects an existing token for a disabled client before resolving %s',
    async (sub) => {
      mocks.client.mockResolvedValue({ client_id: 'client-a', enabled: false });
      expect(await inspect({ sub })).toMatchObject({
        valid: false,
        error: { error: 'invalid_token', statusCode: 401 },
      });
      expect(mocks.findWithdrawal).not.toHaveBeenCalled();
    }
  );

  it('accepts a JWT bearer issuer without an OAuth client row', async () => {
    mocks.client.mockResolvedValue(null);
    expect(
      await inspect({
        client_id: 'https://trusted.example',
        authrim_subject_issuer: 'https://trusted.example',
      })
    ).toMatchObject({ valid: true });
    expect(mocks.client).toHaveBeenCalledWith(expect.anything(), env, 'https://trusted.example', {
      includeDisabled: true,
    });
    expect(mocks.findWithdrawal).not.toHaveBeenCalled();
  });

  it('does not require user consent for a machine token', async () => {
    expect(await inspect({ sub: 'client-a' })).toMatchObject({ valid: true });
    expect(mocks.findWithdrawal).not.toHaveBeenCalled();
  });
});
