/**
 * Authorization code grant for a wallet (attest_jwt_client_auth, HAIP): the client attestation
 * is the only way to authenticate, the code must come from the pushed DPoP-bound flow for the
 * credential scope, and the response carries neither an ID token nor a refresh token
 * (src/token.ts handleAuthorizationCodeGrant, authenticateTokenWallet).
 */
import {
  mocks,
  walletAuth,
  resetHarness,
  useCodeStore,
  postToken,
  expectOAuthError,
  DIRECT_AUTH_REDIRECT_URI,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthCodeData, createPublicClient } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const wallet = createPublicClient({
  client_id: 'keyring-wallet',
  token_endpoint_auth_method: 'attest_jwt_client_auth',
  dpop_bound_access_tokens: true,
  grant_types: ['authorization_code'],
  redirect_uris: ['https://wallet.example.com/cb'],
  require_pkce: false,
});
const REDIRECT = 'https://wallet.example.com/cb';
const attestation = {
  'oauth-client-attestation': 'attestation.jwt.value',
  'oauth-client-attestation-pop': 'pop.jwt.value',
  DPoP: 'dpop-proof',
};

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(wallet);
  mocks.extractDPoPProof.mockReturnValue('dpop-proof');
  mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-1' });
  walletAuth.authenticate.mockResolvedValue({ ok: true, client: wallet });
});

const request = (extra: Record<string, string> = {}) => ({
  grant_type: 'authorization_code',
  code: 'valid-auth-code',
  redirect_uri: REDIRECT,
  client_id: wallet.client_id,
  ...extra,
});

const code = (overrides: object = {}) =>
  createAuthCodeData({
    scope: 'authrim_admin_credential',
    redirectUri: REDIRECT,
    dpopJkt: 'jkt-1',
    ...overrides,
  });

describe('wallet client at the token endpoint', () => {
  it('issues a DPoP-bound access token with no ID token and no refresh token', async () => {
    useCodeStore(env, code());
    const { response, body } = await postToken(env, request(), attestation);
    expect(response.status).toBe(200);
    expect(body.token_type).toBe('DPoP');
    expect(body.access_token).toBeDefined();
    expect(body.id_token).toBeUndefined();
    expect(body.refresh_token).toBeUndefined();
    expect(mocks.createIDToken).not.toHaveBeenCalled();
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
    expect(walletAuth.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: wallet.client_id })
    );
  });

  it('authenticates only by attestation: none presented is refused', async () => {
    useCodeStore(env, code());
    const result = await postToken(env, request(), { DPoP: 'dpop-proof' });
    expectOAuthError(result, 401, 'invalid_client');
    expect(walletAuth.authenticate).not.toHaveBeenCalled();
  });

  it('refuses a secret next to the attestation', async () => {
    useCodeStore(env, code());
    const result = await postToken(env, request({ client_secret: 'secret' }), attestation);
    expectOAuthError(result, 401, 'invalid_client');
  });

  it('refuses a failed attestation without saying why, and an unavailable allowlist as 503', async () => {
    useCodeStore(env, code());
    walletAuth.authenticate.mockResolvedValue({ ok: false, error: 'pop_replayed' });
    expectOAuthError(
      await postToken(env, request(), attestation),
      401,
      'invalid_client',
      'Client authentication failed'
    );
    walletAuth.authenticate.mockResolvedValue({ ok: false, error: 'wallet_allowlist_unavailable' });
    expect((await postToken(env, request(), attestation)).response.status).toBe(503);
  });

  it('refuses a code without a key binding, one from Direct Auth, and a scope beyond credentials', async () => {
    for (const data of [
      code({ dpopJkt: undefined }),
      code({ redirectUri: DIRECT_AUTH_REDIRECT_URI }),
      code({ scope: 'openid authrim_admin_credential' }),
      code({ scope: 'openid' }),
    ]) {
      useCodeStore(env, data);
      const result = await postToken(
        env,
        request({ redirect_uri: (data as { redirectUri: string }).redirectUri }),
        attestation
      );
      expect(result.response.status, JSON.stringify(data)).toBe(400);
      // Direct Auth's own client scope ceiling may answer first; either way it is refused.
      expect(['invalid_grant', 'invalid_scope']).toContain(result.body.error);
    }
  });

  it('grants only for the tenant issuer: another resource or an audience is refused', async () => {
    for (const extra of [{ resource: 'https://evil.example.com' }, { audience: 'svc://other' }]) {
      useCodeStore(env, code());
      const result = await postToken(env, request(extra), attestation);
      expectOAuthError(result, 400, 'invalid_target');
    }
  });

  it('keeps the credential scope from every client that is not a wallet', async () => {
    mocks.getClientCached.mockResolvedValue(
      createPublicClient({ client_id: 'ordinary', redirect_uris: [REDIRECT], require_pkce: false })
    );
    useCodeStore(env, code({ dpopJkt: undefined }));
    const result = await postToken(env, request({ client_id: 'ordinary' }), { DPoP: 'dpop-proof' });
    expect(result.response.status).toBe(400);
    expect(['invalid_scope', 'invalid_grant', 'invalid_target']).toContain(result.body.error);
  });

  it('requires the DPoP proof whose key the code is bound to', async () => {
    useCodeStore(env, code());
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'another-key' });
    const result = await postToken(env, request(), attestation);
    expect(result.response.status).toBe(400);
    expect(result.body.error).toBe('invalid_grant');
  });
});
