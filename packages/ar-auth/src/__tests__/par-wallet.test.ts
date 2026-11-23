/**
 * PAR with a wallet attestation (attest_jwt_client_auth, HAIP): the wallet is authenticated by
 * its client attestation against the tenant allowlist, needs no stored client, and may ask for the
 * credential scope only, with the code flow, PKCE S256 and a DPoP key binding (src/par.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core';
import { systemSettingsPlatformDocuments } from '@authrim/ar-lib-core/utils/system-settings-fields';

const mocks = vi.hoisted(() => ({
  authenticateWalletClient: vi.fn(),
  getClientCached: vi.fn(),
  storeRequestRpc: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    authenticateWalletClient: mocks.authenticateWalletClient,
    getClientCached: mocks.getClientCached,
    getPARRequestStoreForNewRequest: vi.fn(async () => ({
      requestUri: 'urn:ietf:params:oauth:request_uri:par_test',
      stub: { storeRequestRpc: mocks.storeRequestRpc },
    })),
  };
});

vi.mock('../issuer', () => ({
  getRequestIssuer: vi.fn().mockReturnValue('https://op.example.com'),
}));

import { parHandler } from '../par';

const walletClient = {
  client_id: 'keyring-wallet',
  redirect_uris: ['https://wallet.example.com/cb'],
  token_endpoint_auth_method: 'attest_jwt_client_auth',
};

const walletHeaders: Record<string, string> = {
  'content-type': 'application/x-www-form-urlencoded',
  'oauth-client-attestation': 'attestation.jwt.value',
  'oauth-client-attestation-pop': 'pop.jwt.value',
};

const walletBody = (
  scope: string,
  extra: Record<string, string | undefined> = {}
): Record<string, string | undefined> => ({
  client_id: 'keyring-wallet',
  response_type: 'code',
  redirect_uri: 'https://wallet.example.com/cb',
  scope,
  code_challenge: 'c'.repeat(43),
  code_challenge_method: 'S256',
  dpop_jkt: 'A'.repeat(43),
  ...extra,
});

function settings(document: Record<string, unknown> = {}): KVNamespace {
  const documents = systemSettingsPlatformDocuments(document);
  return {
    get: vi.fn(async (key: string) => (key in documents ? JSON.stringify(documents[key]) : null)),
  } as unknown as KVNamespace;
}

async function push(
  body: Record<string, string | undefined>,
  options: { headers?: Record<string, string>; settings?: KVNamespace } = {}
): Promise<Response> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    (c as unknown as { set: (k: string, v: string) => void }).set('tenantId', 'default');
    await next();
  });
  app.post('/par', parHandler);
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) if (value !== undefined) form.set(key, value);
  const env = {
    ISSUER_URL: 'https://op.example.com',
    SETTINGS: options.settings ?? settings(),
    PAR_REQUEST_STORE: {},
    DPOP_JTI_STORE: {},
  } as unknown as Env;
  return app.request(
    '/par',
    { method: 'POST', headers: options.headers ?? walletHeaders, body: form.toString() },
    env
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateWalletClient.mockResolvedValue({ ok: true, client: walletClient });
  mocks.getClientCached.mockResolvedValue(null);
  mocks.storeRequestRpc.mockResolvedValue(undefined);
});

describe('PAR wallet attestation', () => {
  it('authenticates a wallet without any stored client and stores the request', async () => {
    const response = await push(walletBody('authrim_admin_credential'));
    expect(response.status).toBe(201);
    expect(mocks.authenticateWalletClient).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: 'https://op.example.com', clientId: 'keyring-wallet' })
    );
    // Only stored rows are consulted for a collision, never the allowlist.
    const lookup = mocks.getClientCached.mock.calls[0] as unknown[];
    expect(lookup[2]).toBe('keyring-wallet');
    expect(lookup[3]).toEqual({ includeDisabled: true, storedOnly: true });
    expect(mocks.storeRequestRpc).toHaveBeenCalled();
  });

  it('refuses a failed attestation without saying why, and an unavailable allowlist as 503', async () => {
    mocks.authenticateWalletClient.mockResolvedValue({ ok: false, error: 'pop_replayed' });
    const refused = await push(walletBody('authrim_admin_credential'));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      error: 'invalid_client',
      error_description: 'Client authentication failed',
    });
    mocks.authenticateWalletClient.mockResolvedValue({
      ok: false,
      error: 'wallet_allowlist_unavailable',
    });
    expect((await push(walletBody('authrim_admin_credential'))).status).toBe(503);
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('lets a wallet ask for the credential scope only', async () => {
    for (const scope of [
      'openid authrim_admin_credential',
      'openid',
      'authrim_admin_credential admin',
    ]) {
      const response = await push(walletBody(scope));
      expect(response.status, scope).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_scope' });
    }
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('refuses rich authorization details from a wallet, and the credential scope from anyone else', async () => {
    const withDetails = await push(
      walletBody('authrim_admin_credential', {
        authorization_details: '[{"type":"payment_initiation"}]',
      })
    );
    expect(withDetails.status).toBe(400);
    mocks.getClientCached.mockResolvedValue({
      client_id: 'client-123',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
    });
    const ordinary = await push(
      {
        client_id: 'client-123',
        response_type: 'code',
        redirect_uri: 'https://client.example.com/callback',
        scope: 'openid authrim_admin_credential',
      },
      { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
    );
    expect(ordinary.status).toBe(400);
    expect(await ordinary.json()).toMatchObject({ error: 'invalid_scope' });
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('refuses a wallet whose id collides with a stored client, disabled or not', async () => {
    mocks.getClientCached.mockResolvedValue({ client_id: 'keyring-wallet', enabled: false });
    expect((await push(walletBody('authrim_admin_credential'))).status).toBe(401);
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('requires PKCE S256, the code flow and a DPoP key binding from a wallet', async () => {
    for (const extra of [
      { code_challenge: undefined },
      { code_challenge_method: 'plain' },
      { response_type: 'token' },
      { dpop_jkt: undefined },
    ]) {
      const response = await push(walletBody('authrim_admin_credential', extra));
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('never lets an attestation authenticate an ordinary client', async () => {
    mocks.authenticateWalletClient.mockResolvedValue({ ok: false, error: 'wallet_not_allowed' });
    const response = await push({ ...walletBody('openid'), client_id: 'client-123' });
    expect(response.status).toBe(401);
    expect(mocks.getClientCached).not.toHaveBeenCalled();
  });

  it('refuses a wallet under FAPI, as the token endpoint does, even without requirePrivateKeyJwt', async () => {
    const response = await push(walletBody('authrim_admin_credential'), {
      settings: settings({ fapi: { enabled: true, requirePrivateKeyJwt: false } }),
    });
    expect(response.status).toBe(401);
    expect(mocks.storeRequestRpc).not.toHaveBeenCalled();
  });

  it('refuses a wallet client that presents no attestation', async () => {
    mocks.getClientCached.mockResolvedValue(walletClient);
    const response = await push(walletBody('authrim_admin_credential'), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.status).toBe(401);
    expect(mocks.authenticateWalletClient).not.toHaveBeenCalled();
  });
});
