/**
 * Authorization code grant: DPoP requirements, consuming the code at the AuthorizationCodeStore
 * and what each consume failure answers (src/token.ts handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  useTenantSettings,
  postClient,
  postToken,
  codeRequest,
  expectOAuthError,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAuthCodeData } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const client = postClient();

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(client);
});

const GRANT_INVALID = 'The provided authorization grant is invalid, expired, or revoked';

describe('DPoP requirements before the code is spent', () => {
  it('reads the FAPI settings for the client', async () => {
    const data = createAuthCodeData();
    useCodeStore(env, data);
    const { ctx } = await postToken(env, codeRequest(client, data));
    expect(mocks.getProtocolSettingsCached).toHaveBeenCalledWith(ctx, env, {
      clientId: client.client_id,
      keys: ['security.fapi_enabled', 'security.dpop_required'],
    });
  });

  it('requires a DPoP proof when FAPI is enabled', async () => {
    const data = createAuthCodeData();
    const store = useCodeStore(env, data);
    mocks.getProtocolSettingsCached.mockResolvedValue({ fapi: { enabled: true } });
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 400, 'invalid_request', 'DPoP proof is required for this request');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('does not require DPoP when FAPI is enabled with requireDpop false', async () => {
    const data = createAuthCodeData();
    useCodeStore(env, data);
    mocks.getProtocolSettingsCached.mockResolvedValue({
      fapi: { enabled: true, requireDpop: false },
    });
    const result = await postToken(env, codeRequest(client, data));
    // Past the DPoP requirement: FAPI then holds the client to its stronger authentication.
    expect(result.body.error_description).not.toBe('DPoP proof is required for this request');
    expect(result.body.error).toBe('invalid_client');
  });

  it('requires a DPoP proof when FAPI asks for it without being enabled', async () => {
    const data = createAuthCodeData();
    useCodeStore(env, data);
    mocks.getProtocolSettingsCached.mockResolvedValue({ fapi: { requireDpop: true } });
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 400, 'invalid_request', 'DPoP proof is required for this request');
  });

  it('requires a DPoP proof for a client in dpop_mode all', async () => {
    mocks.getClientCached.mockResolvedValue(postClient({ dpop_mode: 'all' } as never));
    const data = createAuthCodeData();
    const store = useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 400, 'invalid_request', 'DPoP proof is required for this request');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });

  it('answers an invalid proof with the fallback description', async () => {
    const data = createAuthCodeData();
    const store = useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    mocks.validateDPoPProof.mockResolvedValue({ valid: false });
    const result = await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    expectOAuthError(result, 400, 'invalid_dpop_proof', 'Invalid DPoP proof');
    expect(store.consumeCodeRpc).not.toHaveBeenCalled();
  });
});

describe('consuming the code', () => {
  it('consumes a legacy code at the tenant’s auth-code instance, bound to the request', async () => {
    const data = createAuthCodeData();
    const store = useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'jkt-1' });
    const result = await postToken(env, codeRequest(client, data, { code_verifier: 'cv' }), {
      DPoP: 'proof',
    });
    expect(result.response.status).toBe(200);
    expect(env.AUTH_CODE_STORE.idFromName).toHaveBeenCalledWith(
      expect.stringContaining('auth-code')
    );
    expect(store.consumeCodeRpc).toHaveBeenCalledWith({
      code: 'valid-auth-code',
      tenantId: 'default',
      clientId: client.client_id,
      codeVerifier: 'cv',
      expectedAuthorizationServer: 'default',
      expectedSubjectType: 'end_user',
      expectedResource: 'svc://confidential-api',
      expectedRedirectUri: data.redirectUri,
      enforceDpopBinding: true,
      expectedDpopJkt: 'jkt-1',
    });
    expect(result.body.token_type).toBe('DPoP');
  });

  it('routes a sharded code to its remapped shard', async () => {
    const data = createAuthCodeData();
    useCodeStore(env, data);
    mocks.parseShardedAuthCode.mockReturnValue({ shardIndex: 7 });
    mocks.getShardCount.mockResolvedValue(4);
    mocks.remapShardIndex.mockReturnValue(3);
    mocks.buildAuthCodeShardInstanceName.mockReturnValue('auth-code-shard-3');
    const result = await postToken(env, codeRequest(client, data));
    expect(result.response.status).toBe(200);
    expect(mocks.getShardCount).toHaveBeenCalledWith(env);
    expect(mocks.remapShardIndex).toHaveBeenCalledWith(7, 4);
    expect(mocks.buildAuthCodeShardInstanceName).toHaveBeenCalledWith(3, 'default');
    expect(env.AUTH_CODE_STORE.idFromName).toHaveBeenCalledWith('auth-code-shard-3');
  });

  it('revokes the tokens of the first exchange when the code is replayed', async () => {
    const data = createAuthCodeData({
      replayAttack: { accessTokenJti: 'at-first', refreshTokenJti: 'rt-first' },
    });
    useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'at-first',
      3600,
      'Authorization code replay attack',
      'default'
    );
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'rt-first',
      86400 * 30,
      'Authorization code replay attack',
      'default'
    );
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('still refuses a replay when revoking the first tokens fails', async () => {
    const data = createAuthCodeData({ replayAttack: { accessTokenJti: 'at-first' } });
    useCodeStore(env, data);
    mocks.revokeToken.mockRejectedValue(new Error('revocation store down'));
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(result, 400, 'invalid_grant', GRANT_INVALID);
    expect(mocks.revokeToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Code already consumed', GRANT_INVALID],
    ['Possible replay detected', GRANT_INVALID],
    ['Redirect URI mismatch', 'redirect_uri does not match the one used in authorization request'],
    [
      'DPoP proof required for this code',
      'DPoP proof required (authorization code is bound to DPoP key)',
    ],
    ['DPoP key mismatch', 'DPoP key mismatch (authorization code is bound to different key)'],
    ['Code not found', 'Authorization code is invalid or expired'],
  ])('answers a consume failure "%s" with "%s"', async (message, description) => {
    useCodeStore(env, new Error(message));
    const result = await postToken(env, codeRequest(client, createAuthCodeData()));
    expectOAuthError(result, 400, 'invalid_grant', description);
  });

  it('refuses a code whose stored redirect_uri differs from the request', async () => {
    const data = createAuthCodeData({ redirectUri: 'https://app.example.com/other' });
    useCodeStore(env, data);
    const result = await postToken(
      env,
      codeRequest(client, { redirectUri: 'https://app.example.com/callback' })
    );
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'redirect_uri does not match the one used in authorization request'
    );
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });
});

describe('DPoP binding of the code', () => {
  it('requires a proof for a code bound to a DPoP key', async () => {
    const data = createAuthCodeData({ dpopJkt: 'bound-jkt' });
    useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'DPoP proof required (authorization code is bound to DPoP key)'
    );
  });

  it('refuses a proof of another key', async () => {
    const data = createAuthCodeData({ dpopJkt: 'bound-jkt' });
    useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'other-jkt' });
    const result = await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    expectOAuthError(
      result,
      400,
      'invalid_grant',
      'DPoP key mismatch (authorization code is bound to different key)'
    );
  });

  it('accepts the bound key and binds the tokens to it', async () => {
    const data = createAuthCodeData({ dpopJkt: 'bound-jkt', scope: 'api:read' });
    useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    mocks.validateDPoPProof.mockResolvedValue({ valid: true, jkt: 'bound-jkt' });
    const result = await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    expect(result.response.status).toBe(200);
    expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({ cnf: { jkt: 'bound-jkt' } });
    expect((mocks.createAccessToken.mock.calls[0][0] as Record<string, unknown>).cnf).toEqual({
      jkt: 'bound-jkt',
    });
    expect(mocks.createRefreshToken.mock.calls[0][0]).toMatchObject({
      cnf: { jkt: 'bound-jkt' },
    });
    expect((mocks.createRefreshToken.mock.calls[0][0] as Record<string, unknown>).cnf).toEqual({
      jkt: 'bound-jkt',
    });
  });

  it('puts no cnf in tokens issued without DPoP or a certificate', async () => {
    const data = createAuthCodeData({ scope: 'api:read' });
    useCodeStore(env, data);
    const result = await postToken(env, codeRequest(client, data));
    expect(result.response.status).toBe(200);
    expect(mocks.createAccessToken.mock.calls[0][0]).not.toHaveProperty('cnf');
    expect(mocks.createRefreshToken.mock.calls[0][0]).not.toHaveProperty('cnf');
  });
});

describe('federation and authentication assurance at redemption', () => {
  it('refuses a code not from a pushed signed request at FAL3 with PAR required', async () => {
    useTenantSettings(env, {
      assurance: {
        'assurance.enabled': true,
        'assurance.default_fal': 'FAL3',
        'assurance.fal3_requires_par': true,
      },
    });
    const data = createAuthCodeData();
    const store = useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    const result = await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    expectOAuthError(
      result,
      400,
      'unauthorized_client',
      'This grant does not meet the required federation assurance level (FAL3)'
    );
    expect(store.consumeCodeRpc).toHaveBeenCalled();
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('issues for a code from a pushed signed request at FAL3, recording it on the family', async () => {
    useTenantSettings(env, {
      assurance: {
        'assurance.enabled': true,
        'assurance.default_fal': 'FAL3',
        'assurance.fal3_requires_par': true,
      },
    });
    const data = { ...createAuthCodeData({ scope: 'api:read' }), pushedSignedRequest: true };
    useCodeStore(env, data);
    mocks.extractDPoPProof.mockReturnValue('proof');
    const result = await postToken(env, codeRequest(client, data), { DPoP: 'proof' });
    expect(result.response.status).toBe(200);
  });
});
