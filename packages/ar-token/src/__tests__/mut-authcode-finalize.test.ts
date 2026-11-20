/**
 * Authorization code grant: token creation failures, registering the issued tokens with the code
 * (replay revocation), the response and its events (src/token.ts handleAuthorizationCodeGrant).
 */
import {
  mocks,
  resetHarness,
  useCodeStore,
  postClient,
  postToken,
  codeRequest,
  expectOAuthError,
} from './helpers/mut-authcode-harness';
import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { TOKEN_EVENTS } from '@authrim/ar-lib-core';
import { createAuthCodeData } from './helpers/fixtures';
import type { MockEnv } from './helpers/mocks';

let env: MockEnv;
const client = postClient();
const GRANT_INVALID = 'The provided authorization grant is invalid, expired, or revoked';

beforeEach(() => {
  env = resetHarness();
  mocks.getClientCached.mockResolvedValue(client);
});

async function exchange(
  data: object = createAuthCodeData({ scope: 'api:read' }),
  registered: unknown = true
) {
  const store = useCodeStore(env, data, registered);
  const result = await postToken(env, codeRequest(client, data as { redirectUri: string }));
  return { ...result, store };
}

function rotatorStub() {
  return env.REFRESH_TOKEN_ROTATOR.get({} as never) as unknown as { createFamilyRpc: Mock };
}

describe('token creation failures', () => {
  it('answers 500 when the access token cannot be created', async () => {
    mocks.createAccessToken.mockRejectedValue(new Error('sign failed'));
    const { response, body, store } = await exchange();
    expectOAuthError({ response, body }, 500, 'server_error', 'Failed to create access token');
    expect(store.registerIssuedTokensRpc).not.toHaveBeenCalled();
  });

  it('answers 500 when at_hash cannot be calculated', async () => {
    mocks.calculateAtHash.mockRejectedValue(new Error('hash failed'));
    const result = await exchange();
    expectOAuthError(result, 500, 'server_error', 'Failed to calculate token hash');
  });

  it('answers 500 when the ID token cannot be created', async () => {
    mocks.createIDToken.mockRejectedValue(new Error('sign failed'));
    const result = await exchange();
    expectOAuthError(result, 500, 'server_error', 'Failed to create ID token');
  });

  it('answers 500 when the refresh token family cannot be registered', async () => {
    rotatorStub().createFamilyRpc.mockRejectedValue(new Error('rotator down'));
    const result = await exchange();
    expectOAuthError(result, 500, 'server_error', 'Failed to register refresh token');
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
  });

  it('answers 500 when the refresh token cannot be created', async () => {
    mocks.createRefreshToken.mockRejectedValue(new Error('sign failed'));
    const { response, body, store } = await exchange();
    expectOAuthError({ response, body }, 500, 'server_error', 'Failed to create refresh token');
    expect(store.registerIssuedTokensRpc).not.toHaveBeenCalled();
  });

  it('ends a family whose consent was withdrawn while it was created', async () => {
    mocks.findConsentRevocation
      .mockResolvedValueOnce({ generation: 0, revokedAt: null })
      .mockResolvedValue({ generation: 1, revokedAt: Date.now() });
    const { response, store } = await exchange();
    expect(response.status).toBe(400);
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
    expect(store.registerIssuedTokensRpc).not.toHaveBeenCalled();
  });
});

describe('registering the issued tokens with the code', () => {
  it('registers both token ids with the consumed code', async () => {
    const { store, ctx } = await exchange();
    const family = rotatorStub().createFamilyRpc.mock.calls[0][0] as { jti: string };
    expect(store.registerIssuedTokensRpc).toHaveBeenCalledWith(
      'valid-auth-code',
      'at-jti-001',
      family.jti
    );
    // The family index write is kept alive past the response.
    expect(ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(2);
  });

  it('revokes both tokens and refuses when a replay won the registration race', async () => {
    const { response, body } = await exchange(undefined, false);
    expectOAuthError({ response, body }, 400, 'invalid_grant', GRANT_INVALID);
    const family = rotatorStub().createFamilyRpc.mock.calls[0][0] as { jti: string };
    expect(mocks.revokeToken).toHaveBeenCalledTimes(2);
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'at-jti-001',
      3600,
      'Authorization code replay raced token issuance',
      'default'
    );
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      family.jti,
      mocks.createRefreshToken.mock.calls[0][3],
      'Authorization code replay raced token issuance',
      'default'
    );
  });

  it('revokes only the access token of a grant without a refresh token', async () => {
    const { response } = await exchange(createAuthCodeData({ scope: 'openid' }), false);
    expect(response.status).toBe(400);
    expect(mocks.revokeToken).toHaveBeenCalledTimes(1);
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'at-jti-001',
      3600,
      'Authorization code replay raced token issuance',
      'default'
    );
  });

  it('revokes both tokens and answers 500 when the registration fails', async () => {
    const { response, body } = await exchange(undefined, new Error('DO unavailable'));
    expectOAuthError({ response, body }, 500, 'server_error', 'Failed to finalize token issuance');
    const family = rotatorStub().createFamilyRpc.mock.calls[0][0] as { jti: string };
    expect(mocks.revokeToken).toHaveBeenCalledTimes(2);
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'at-jti-001',
      3600,
      'Authorization code token registration failed',
      'default'
    );
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      family.jti,
      mocks.createRefreshToken.mock.calls[0][3],
      'Authorization code token registration failed',
      'default'
    );
  });

  it('revokes only the access token when registration fails for a grant without refresh', async () => {
    const { response } = await exchange(
      createAuthCodeData({ scope: 'openid' }),
      new Error('DO unavailable')
    );
    expect(response.status).toBe(500);
    expect(mocks.revokeToken).toHaveBeenCalledTimes(1);
    expect(mocks.revokeToken).toHaveBeenCalledWith(
      env,
      'at-jti-001',
      3600,
      'Authorization code token registration failed',
      'default'
    );
  });
});

describe('the token response', () => {
  it('is not cacheable', async () => {
    const { ctx } = await exchange();
    expect(ctx.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(ctx.header).toHaveBeenCalledWith('Pragma', 'no-cache');
  });

  it('answers the issued tokens and the granted scope', async () => {
    const { body } = await exchange();
    expect(body).toMatchObject({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: 'mock-id-token',
      refresh_token: 'mock-refresh-token',
      scope: 'api:read',
    });
    expect(body).not.toHaveProperty('device_secret');
  });

  it('publishes the access, refresh and ID token events', async () => {
    const before = Math.floor(Date.now() / 1000);
    await exchange(createAuthCodeData({ scope: 'api:read api:write' }));
    const family = rotatorStub().createFamilyRpc.mock.calls[0][0] as { jti: string };
    const events = mocks.publishEvent.mock.calls.map(
      ([, event]) => event as Record<string, unknown>
    );
    expect(events).toHaveLength(3);
    const access = events.find((e) => e.type === TOKEN_EVENTS.ACCESS_ISSUED) ?? {};
    expect(access).toMatchObject({
      tenantId: 'default',
      data: {
        jti: 'at-jti-001',
        clientId: client.client_id,
        userId: 'user-001',
        scopes: ['api:read', 'api:write'],
        grantType: 'authorization_code',
      },
    });
    const expiresAt = (access.data as { expiresAt: number }).expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
    expect(events.find((e) => e.type === TOKEN_EVENTS.REFRESH_ISSUED)).toMatchObject({
      data: {
        jti: family.jti,
        clientId: client.client_id,
        userId: 'user-001',
        scopes: ['api:read', 'api:write'],
        grantType: 'authorization_code',
      },
    });
    expect(events.find((e) => e.type === TOKEN_EVENTS.ID_ISSUED)).toMatchObject({
      data: { clientId: client.client_id, userId: 'user-001', grantType: 'authorization_code' },
    });
  });

  it('publishes no refresh event for a grant without a refresh token', async () => {
    await exchange(createAuthCodeData({ scope: 'openid' }));
    const types = mocks.publishEvent.mock.calls.map(([, e]) => (e as { type: string }).type);
    expect(types).toEqual([TOKEN_EVENTS.ACCESS_ISSUED, TOKEN_EVENTS.ID_ISSUED]);
  });

  it('still answers when publishing an event fails', async () => {
    mocks.publishEvent.mockRejectedValue(new Error('queue down'));
    const { response, ctx } = await exchange();
    expect(response.status).toBe(200);
    const pending = (ctx.executionCtx.waitUntil as Mock).mock.calls.map(
      ([p]) => p as Promise<unknown>
    );
    await expect(Promise.all(pending)).resolves.toBeDefined();
  });
});
