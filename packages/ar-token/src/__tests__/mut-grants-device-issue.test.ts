/**
 * Device code grant (RFC 8628 section 3.5): what an approved device code issues. The claims of
 * the access, ID and refresh tokens, the refresh token family and its index, the events and the
 * response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mocks,
  resetHarness,
  callToken,
  answerQueryOne,
  pollingStore,
  publishedEvents,
  DEVICE_GRANT,
} from './helpers/mut-grants-harness';
import type { MockEnv } from './helpers/mocks';
import { createPublicClient } from './helpers/fixtures';
import { tokenHandler } from '../token';

const CLIENT_ID = 'device-client-001';
const DEVICE_CODE = 'device-code-issue';
const RESOURCE = 'svc://device-api';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    device_code: DEVICE_CODE,
    user_code: 'ABCD-EFGH',
    client_id: CLIENT_ID,
    scope: 'openid profile offline_access',
    status: 'approved',
    sub: 'user-123',
    created_at: Date.now() - 10_000,
    expires_at: Date.now() + 60_000,
    ...overrides,
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('device code grant: issuance', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = resetHarness();
    mocks.getClientCached.mockResolvedValue(
      createPublicClient({
        client_id: CLIENT_ID,
        grant_types: [DEVICE_GRANT],
        default_resource: RESOURCE,
      })
    );
  });

  async function redeem(meta: Record<string, unknown> = metadata()) {
    env.DEVICE_CODE_STORE.get = vi
      .fn()
      .mockReturnValue({ fetch: pollingStore('device_code', meta) });
    return callToken(tokenHandler, env, {
      grant_type: DEVICE_GRANT,
      device_code: DEVICE_CODE,
      client_id: CLIENT_ID,
    });
  }

  it('issues DPoP-bound tokens with RBAC claims, embedded permissions and a recorded family', async () => {
    mocks.extractDPoPProof.mockReturnValue('dpop-proof');
    mocks.getAccessTokenRBACClaims.mockResolvedValue({ authrim_roles: ['viewer'] });
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
      permissions: ['docs:read'],
      scopedPermissions: [{ resource: 'docs', actions: ['read'] }],
    });
    const before = nowSeconds();

    const result = await redeem();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      access_token: 'mock-access-token',
      token_type: 'DPoP',
      expires_in: 3600,
      id_token: 'mock-id-token',
      refresh_token: 'mock-refresh-token',
      refresh_token_expires_in: 86400 * 30,
      scope: 'openid profile offline_access',
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');

    expect(mocks.evaluatePermissionEmbeddingForScope).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      'openid profile offline_access',
      expect.objectContaining({ tenantId: 'default', maxPermissions: 50 })
    );
    const [accessClaims, , , expiresIn, jti] = mocks.createAccessToken.mock.calls[0];
    expect(accessClaims).toEqual({
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: RESOURCE,
      scope: 'openid profile offline_access',
      client_id: CLIENT_ID,
      authrim_roles: ['viewer'],
      cnf: { jkt: 'proof-jkt' },
      authrim_consent_generation: 0,
      authrim_release: [],
      authrim_permissions: ['docs:read'],
      authrim_scoped_permissions: [{ resource: 'docs', actions: ['read'] }],
    });
    expect(expiresIn).toBe(3600);
    expect(jti).toBe('jti-region-001');

    const idClaims = mocks.createIDToken.mock.calls[0][0];
    expect(idClaims).toMatchObject({ sub: 'user-123', aud: CLIENT_ID });
    expect(idClaims.auth_time).toBeGreaterThanOrEqual(before);
    expect(idClaims.auth_time).toBeLessThanOrEqual(nowSeconds());

    const family = mocks.createRefreshTokenFamily.mock.calls[0][1];
    expect(family).toEqual({
      userId: 'user-123',
      clientId: CLIENT_ID,
      scope: 'openid profile offline_access',
      ttl: 86400 * 30,
      tenantId: 'default',
      resourceAudience: RESOURCE,
      authContext: { auth_time: idClaims.auth_time },
      consentGeneration: 0,
      releaseApproval: [],
      issuedSubject: 'user-123',
    });
    const [refreshClaims, , , refreshExpiry, refreshJti] = mocks.createRefreshToken.mock.calls[0];
    expect(refreshClaims).toEqual({
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: CLIENT_ID,
      scope: 'openid profile offline_access',
      client_id: CLIENT_ID,
      cnf: { jkt: 'proof-jkt' },
    });
    expect(refreshExpiry).toBe(86400 * 30);
    expect(refreshJti).toBe('v1_0_family-jti');
    expect(mocks.storeRefreshToken).not.toHaveBeenCalled();

    // The family index and the events are both left to waitUntil.
    expect(result.ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(2);
    const events = await publishedEvents(result.ctx);
    const issuedAt = mocks.recordRefreshTokenFamilyIndex.mock.calls[0][1];
    expect(issuedAt).toMatchObject({
      jti: 'v1_0_family-jti',
      tenantId: 'default',
      userId: 'user-123',
      clientId: CLIENT_ID,
      generation: 1,
    });
    expect(issuedAt.expiresAt - Date.now()).toBeGreaterThan(86400 * 30 * 1000 - 60_000);
    expect(issuedAt.expiresAt - Date.now()).toBeLessThanOrEqual(86400 * 30 * 1000);

    const scopes = ['openid', 'profile', 'offline_access'];
    expect(events).toEqual([
      {
        type: 'token.access.issued',
        tenantId: 'default',
        data: {
          jti: 'at-jti-001',
          clientId: CLIENT_ID,
          userId: 'user-123',
          scopes,
          expiresAt: expect.any(Number) as number,
          grantType: DEVICE_GRANT,
        },
      },
      {
        type: 'token.refresh.issued',
        tenantId: 'default',
        data: {
          jti: 'v1_0_family-jti',
          clientId: CLIENT_ID,
          userId: 'user-123',
          scopes,
          grantType: DEVICE_GRANT,
        },
      },
      {
        type: 'token.id.issued',
        tenantId: 'default',
        data: { clientId: CLIENT_ID, userId: 'user-123', grantType: DEVICE_GRANT },
      },
    ]);
    expect((events[0].data.expiresAt as number) - nowSeconds()).toBeGreaterThan(3500);
  });

  it('binds the tokens of a certificate-bound client to its certificate', async () => {
    mocks.getClientCached.mockResolvedValue(
      createPublicClient({
        client_id: CLIENT_ID,
        default_resource: RESOURCE,
        tls_client_certificate_bound_access_tokens: true,
      })
    );
    mocks.validateClientCertificateBinding.mockResolvedValue({ valid: true, thumbprint: 'thumb' });

    const result = await redeem();

    expect(result.body.token_type).toBe('Bearer');
    expect(mocks.createAccessToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
    expect(mocks.createRefreshToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
  });

  it('issues unbound Bearer tokens without a proof or certificate', async () => {
    const result = await redeem();
    expect(result.body.token_type).toBe('Bearer');
    expect(mocks.createAccessToken.mock.calls[0][0]).not.toHaveProperty('cnf');
    expect(mocks.createRefreshToken.mock.calls[0][0]).not.toHaveProperty('cnf');
  });

  it('embeds no permissions when the evaluation finds none', async () => {
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    await redeem();
    const claims = mocks.createAccessToken.mock.calls[0][0];
    expect(claims).not.toHaveProperty('authrim_permissions');
    expect(claims).not.toHaveProperty('authrim_scoped_permissions');
  });

  it('does not evaluate permissions while policy embedding is off', async () => {
    mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
      permissions: ['docs:read'],
      scopedPermissions: [{ resource: 'docs', actions: ['read'] }],
    });
    await redeem();
    expect(mocks.evaluatePermissionEmbeddingForScope).not.toHaveBeenCalled();
    expect(mocks.createAccessToken.mock.calls[0][0]).not.toHaveProperty('authrim_permissions');
  });

  it('stores the refresh token itself when there is no rotator', async () => {
    env.REFRESH_TOKEN_ROTATOR = undefined as unknown as MockEnv['REFRESH_TOKEN_ROTATOR'];
    const result = await redeem();
    expect(result.status).toBe(200);
    expect(mocks.createRefreshTokenFamily).not.toHaveBeenCalled();
    const refreshJti = mocks.createRefreshToken.mock.calls[0][4] as string;
    expect(refreshJti).toMatch(/^rt_[0-9a-f-]{36}$/);
    const [, storedJti, stored, tenant] = mocks.storeRefreshToken.mock.calls[0];
    expect(storedJti).toBe(refreshJti);
    expect(tenant).toBe('default');
    expect(stored).toEqual({
      jti: refreshJti,
      client_id: CLIENT_ID,
      sub: 'user-123',
      scope: 'openid profile offline_access',
      resource_aud: RESOURCE,
      iat: expect.any(Number) as number,
      exp: expect.any(Number) as number,
    });
    expect(Math.abs(stored.iat - nowSeconds())).toBeLessThanOrEqual(1);
    expect(stored.exp - stored.iat).toBe(86400 * 30);
    expect(result.ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('issues no refresh token without offline_access when the tenant requires it', async () => {
    mocks.settings.oauth['oauth.offline_access_required'] = true;
    const result = await redeem(metadata({ scope: 'openid profile' }));
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty('refresh_token');
    expect(result.body).not.toHaveProperty('refresh_token_expires_in');
    expect(mocks.createRefreshTokenFamily).not.toHaveBeenCalled();
    const events = await publishedEvents(result.ctx);
    expect(events.map((event) => event.type)).toEqual(['token.access.issued', 'token.id.issued']);
  });

  it('issues for a device code that carries no scope', async () => {
    const result = await redeem(metadata({ scope: undefined }));
    expect(result.status).toBe(200);
    expect(mocks.createRefreshTokenFamily.mock.calls[0][1].scope).toBe('');
    const events = await publishedEvents(result.ctx);
    expect(events[0].data.scopes).toEqual([]);
    expect(events[1].data.scopes).toEqual([]);
  });

  it('refuses and revokes a family whose consent was withdrawn while it was created', async () => {
    let reads = 0;
    mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('oauth_client_consent_revocations')
        ? { generation: reads++ === 0 ? 0 : 1, revoked_at: Date.now() - 60_000 }
        : null
    );
    const revoke = vi.fn().mockResolvedValue(true);
    env.REFRESH_TOKEN_ROTATOR.get = vi.fn().mockReturnValue({ revokeFamilyIfFirstJtiRpc: revoke });

    const result = await redeem(metadata({ consent_generation: 0 }));

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_grant',
      error_description: 'The provided authorization grant is invalid, expired, or revoked',
    });
    expect(revoke).toHaveBeenCalledWith('user-123', 'v1_0_family-jti', 'consent_revoked');
    expect(mocks.recordRefreshTokenFamilyIndex).not.toHaveBeenCalled();
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
  });

  it('still issues when the family index cannot be recorded', async () => {
    mocks.recordRefreshTokenFamilyIndex.mockRejectedValue(new Error('index down'));
    const result = await redeem();
    expect(result.status).toBe(200);
    await expect(publishedEvents(result.ctx)).resolves.toHaveLength(3);
    expect(mocks.recordRefreshTokenFamilyIndex).toHaveBeenCalledTimes(1);
  });

  it('carries the release approval a trusted client is given into the family and token', async () => {
    mocks.coreAdapter.query.mockImplementation(async (sql: string) =>
      sql.includes('client_trust_policies')
        ? [
            {
              target_type: 'oidc_client',
              target_id: CLIENT_ID,
              first_party: 1,
              trusted: 1,
              skip_authorization_consent: 1,
            },
          ]
        : []
    );
    answerQueryOne({});
    await redeem();
    const approval = mocks.createAccessToken.mock.calls[0][0].authrim_release;
    expect(approval).toEqual(['*']);
    expect(mocks.createRefreshTokenFamily.mock.calls[0][1].releaseApproval).toEqual(['*']);
  });
});
