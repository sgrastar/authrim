/**
 * refresh_token grant: rotation (theft detection by version), the family index kept in step,
 * the remaining lifetime of a token that is not rotated, the events and the response.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mocks, resetHarness, publishedEvents } from './helpers/mut-grants-harness';
import {
  presentRefreshToken,
  refresh,
  RT_CLIENT_ID,
  RT_JTI,
  RT_SCOPE,
  type PresentedRefreshToken,
} from './helpers/mut-grants-refresh-fixture';
import type { MockEnv } from './helpers/mocks';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('refresh_token grant: rotation and response', () => {
  let env: MockEnv;
  let presented: PresentedRefreshToken;

  beforeEach(() => {
    env = resetHarness();
    presented = presentRefreshToken(env);
  });

  it('rotates a narrowed scope and reports the rotated token', async () => {
    const result = await refresh(env, presented, { scope: 'openid profile' });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: 'mock-id-token',
      refresh_token: 'mock-refresh-token',
      refresh_token_expires_in: 7200,
      scope: 'openid profile',
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(presented.rotateRpc).toHaveBeenCalledWith({
      incomingVersion: 1,
      incomingJti: RT_JTI,
      userId: 'user-001',
      clientId: RT_CLIENT_ID,
      tenantId: 'default',
      requestedScope: 'openid profile',
      lifetime: expect.objectContaining({ ttl: 86400 * 30 }) as unknown,
    });
    const [refreshClaims, , , refreshExpiry, refreshJti, version] =
      mocks.createRefreshToken.mock.calls[0];
    expect(refreshClaims).toEqual({
      iss: 'https://auth.example.com',
      sub: 'user-001',
      aud: RT_CLIENT_ID,
      scope: 'openid profile',
      client_id: RT_CLIENT_ID,
      resource_aud: 'svc://confidential-api',
    });
    expect([refreshExpiry, refreshJti, version]).toEqual([7200, 'rt-rotated-jti', 2]);
    expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({
      sub: 'user-001',
      scope: 'openid profile',
      authrim_release: ['*'],
    });

    expect(result.ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    const events = await publishedEvents(result.ctx);
    const scopes = ['openid', 'profile'];
    expect(events).toEqual([
      {
        type: 'token.access.issued',
        tenantId: 'default',
        data: {
          jti: 'at-jti-001',
          clientId: RT_CLIENT_ID,
          userId: 'user-001',
          scopes,
          expiresAt: expect.any(Number) as number,
          grantType: 'refresh_token',
        },
      },
      {
        type: 'token.refresh.rotated',
        tenantId: 'default',
        data: { clientId: RT_CLIENT_ID, userId: 'user-001', scopes, grantType: 'refresh_token' },
      },
      {
        type: 'token.id.issued',
        tenantId: 'default',
        data: { clientId: RT_CLIENT_ID, userId: 'user-001', grantType: 'refresh_token' },
      },
    ]);
    const remaining = (events[0].data.expiresAt as number) - nowSeconds();
    expect(remaining).toBeGreaterThan(3500);
    expect(remaining).toBeLessThanOrEqual(3600);
  });

  it('passes no requested scope to the rotator when none is requested', async () => {
    await refresh(env, presented);
    expect(presented.rotateRpc.mock.calls[0][0].requestedScope).toBeUndefined();
  });

  it('gives an access token the empty release approval of a family that recorded none', async () => {
    presented = presentRefreshToken(env, { family: { family_release_approval: undefined } });
    await refresh(env, presented);
    expect(mocks.createAccessToken.mock.calls[0][0].authrim_release).toEqual([]);
  });

  it("keeps the family index's expiry in step with the rotation", async () => {
    presented = presentRefreshToken(env, {
      rotation: { familyJti: 'v7_0_family', expiresAt: 1_900_000_000_000 },
    });
    const result = await refresh(env, presented);
    expect(result.ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(2);
    await publishedEvents(result.ctx);
    expect(mocks.updateRefreshTokenFamilyIndexExpiry).toHaveBeenCalledWith(mocks.coreAdapter, {
      tenantId: 'default',
      jti: 'v7_0_family',
      userId: 'user-001',
      clientId: RT_CLIENT_ID,
      generation: 7,
      expiresAt: 1_900_000_000_000,
    });
  });

  it('still answers when the family index cannot be updated', async () => {
    mocks.updateRefreshTokenFamilyIndexExpiry.mockRejectedValue(new Error('index down'));
    presented = presentRefreshToken(env, {
      rotation: { familyJti: 'v7_0_family', expiresAt: 1_900_000_000_000 },
    });
    const result = await refresh(env, presented);
    expect(result.status).toBe(200);
    await expect(publishedEvents(result.ctx)).resolves.toHaveLength(3);
  });

  it('answers 500 when rotation is on but there is no rotator', async () => {
    env.REFRESH_TOKEN_ROTATOR = undefined as unknown as MockEnv['REFRESH_TOKEN_ROTATOR'];
    const result = await refresh(env, presented);
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: 'server_error',
      error_description: 'Refresh token rotation unavailable',
    });
  });

  describe('a rotation the rotator refuses', () => {
    it.each([['token theft detected'], ['family revoked'], ['version mismatch: expected 2']])(
      'answers "revoked" for "%s"',
      async (message) => {
        presented = presentRefreshToken(env, { rotation: new Error(message) });
        const result = await refresh(env, presented);
        expect(result.status).toBe(400);
        expect(result.body).toEqual({
          error: 'invalid_grant',
          error_description: 'Refresh token has been revoked',
        });
        expect(result.headers.get('Cache-Control')).toBe('no-store');
        expect(result.headers.get('Pragma')).toBe('no-cache');
      }
    );

    it.each([
      ['another error', new Error('storage unavailable')],
      ['a value that is not an Error', { reason: 'revoked' }],
    ])('answers a generic rotation failure for %s', async (_label, failure) => {
      presented = presentRefreshToken(env);
      presented.rotateRpc.mockRejectedValue(failure);
      const result = await refresh(env, presented);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'Token rotation failed',
      });
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(result.headers.get('Pragma')).toBe('no-cache');
    });
  });

  describe('with rotation off', () => {
    beforeEach(() => {
      mocks.settings.oauth['oauth.refresh_token_rotation'] = false;
    });

    it('returns the same token for what remains of its own or its family lifetime', async () => {
      presented = presentRefreshToken(env, {
        payload: { exp: nowSeconds() + 86400 },
        family: { exp: nowSeconds() + 600 },
      });
      const result = await refresh(env, presented);
      expect(result.body.refresh_token).toBe(presented.token);
      expect(result.body.refresh_token_expires_in).toBeGreaterThan(590);
      expect(result.body.refresh_token_expires_in).toBeLessThanOrEqual(600);
      expect(presented.rotateRpc).not.toHaveBeenCalled();
      const events = await publishedEvents(result.ctx);
      expect(events.map((event) => event.type)).toEqual(['token.access.issued', 'token.id.issued']);
    });

    it('reports the configured lifetime for a token and family without an expiry', async () => {
      presented = presentRefreshToken(env, { payload: { exp: undefined } });
      const result = await refresh(env, presented);
      expect(result.body.refresh_token_expires_in).toBe(86400 * 30);
    });

    it('publishes no ID token event when no ID token is reissued', async () => {
      mocks.settings.oauth['oauth.refresh_id_token_reissue'] = false;
      const result = await refresh(env, presented);
      expect(result.body.id_token).toBeUndefined();
      const events = await publishedEvents(result.ctx);
      expect(events.map((event) => event.type)).toEqual(['token.access.issued']);
    });
  });

  it('keeps the scope of the family when the request names none', async () => {
    const result = await refresh(env, presented);
    expect(result.body.scope).toBe(RT_SCOPE);
  });
});
