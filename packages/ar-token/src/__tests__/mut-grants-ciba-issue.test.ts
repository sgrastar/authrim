/**
 * CIBA grant (CIBA Core section 10.1.1): what an approved request issues. The claims of the
 * access, ID and refresh tokens, ID token encryption, the refresh token family, the events and
 * the response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import {
  mocks,
  resetHarness,
  callToken,
  pollingStore,
  publishedEvents,
  CIBA_GRANT,
  CLIENT_SECRET,
  CLIENT_SECRET_HASH,
} from './helpers/mut-grants-harness';
import type { MockEnv } from './helpers/mocks';
import { createCIBAClient } from './helpers/fixtures';
import { tokenHandler } from '../token';

const CLIENT_ID = 'ciba-client-001';
const AUTH_REQ_ID = 'auth-req-issue';
const RESOURCE = 'svc://ciba-api';
const SCOPE = 'openid profile offline_access';

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    auth_req_id: AUTH_REQ_ID,
    client_id: CLIENT_ID,
    scope: SCOPE,
    status: 'approved',
    sub: 'user-123',
    delivery_mode: 'poll',
    interval: 5,
    created_at: Date.now() - 10_000,
    expires_at: Date.now() + 60_000,
    token_issued: false,
    ...overrides,
  };
}

function client(overrides: Record<string, unknown> = {}) {
  return createCIBAClient({
    client_secret_hash: CLIENT_SECRET_HASH,
    token_endpoint_auth_method: 'client_secret_post',
    ...overrides,
  });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('CIBA grant: issuance', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = resetHarness();
    mocks.getClientCached.mockResolvedValue(client());
  });

  async function redeem(meta: Record<string, unknown> = metadata()) {
    env.CIBA_REQUEST_STORE.get = vi
      .fn()
      .mockReturnValue({ fetch: pollingStore('auth_req_id', meta) });
    return callToken(tokenHandler, env, {
      grant_type: CIBA_GRANT,
      auth_req_id: AUTH_REQ_ID,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
  }

  it('issues DPoP-bound tokens with RBAC claims, permissions, nonce and acr', async () => {
    mocks.extractDPoPProof.mockReturnValue('dpop-proof');
    mocks.getAccessTokenRBACClaims.mockResolvedValue({ authrim_roles: ['approver'] });
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    mocks.evaluatePermissionEmbeddingForScope.mockResolvedValue({
      permissions: ['pay:approve'],
      scopedPermissions: [{ resource: 'pay', actions: ['approve'] }],
    });

    const result = await redeem(metadata({ nonce: 'n-1', authenticated_acr: 'urn:acr:mfa' }));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      access_token: 'mock-access-token',
      token_type: 'DPoP',
      expires_in: 3600,
      id_token: 'mock-id-token',
      refresh_token: 'mock-refresh-token',
      refresh_token_expires_in: 86400 * 30,
      scope: SCOPE,
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(mocks.evaluatePermissionEmbeddingForScope).toHaveBeenCalledWith(
      expect.anything(),
      'user-123',
      SCOPE,
      expect.objectContaining({ tenantId: 'default', maxPermissions: 50 })
    );
    expect(mocks.createAccessToken.mock.calls[0][0]).toEqual({
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: RESOURCE,
      scope: SCOPE,
      client_id: CLIENT_ID,
      cnf: { jkt: 'proof-jkt' },
      authrim_roles: ['approver'],
      authrim_consent_generation: 0,
      authrim_release: [],
      authrim_permissions: ['pay:approve'],
      authrim_scoped_permissions: [{ resource: 'pay', actions: ['approve'] }],
    });
    expect(mocks.createIDToken.mock.calls[0][0]).toMatchObject({
      sub: 'user-123',
      aud: CLIENT_ID,
      nonce: 'n-1',
      acr: 'urn:acr:mfa',
      at_hash: 'at-hash-value',
    });
    expect(mocks.createRefreshTokenFamily.mock.calls[0][1]).toEqual({
      userId: 'user-123',
      clientId: CLIENT_ID,
      scope: SCOPE,
      ttl: 86400 * 30,
      tenantId: 'default',
      resourceAudience: RESOURCE,
      authContext: { acr: 'urn:acr:mfa' },
      consentGeneration: 0,
      releaseApproval: [],
      issuedSubject: 'user-123',
    });
    // A CIBA refresh token is bound to the client certificate only, never to the DPoP key.
    expect(mocks.createRefreshToken.mock.calls[0][0]).toEqual({
      iss: 'https://auth.example.com',
      sub: 'user-123',
      aud: CLIENT_ID,
      client_id: CLIENT_ID,
      scope: SCOPE,
      resource_aud: RESOURCE,
    });
    expect(mocks.createRefreshToken.mock.calls[0][4]).toBe('v1_0_family-jti');
    expect(mocks.storeRefreshToken).not.toHaveBeenCalled();

    expect(result.ctx.executionCtx.waitUntil).toHaveBeenCalledTimes(2);
    const events = await publishedEvents(result.ctx);
    expect(mocks.recordRefreshTokenFamilyIndex.mock.calls[0][1]).toMatchObject({
      jti: 'v1_0_family-jti',
      userId: 'user-123',
      clientId: CLIENT_ID,
      generation: 1,
    });
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
          grantType: CIBA_GRANT,
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
          grantType: CIBA_GRANT,
        },
      },
      {
        type: 'token.id.issued',
        tenantId: 'default',
        data: { clientId: CLIENT_ID, userId: 'user-123', grantType: CIBA_GRANT },
      },
    ]);
    expect((events[0].data.expiresAt as number) - nowSeconds()).toBeGreaterThan(3500);
  });

  it('binds the tokens of a certificate-bound client to its certificate', async () => {
    mocks.getClientCached.mockResolvedValue(
      client({ tls_client_certificate_bound_access_tokens: true })
    );
    mocks.validateClientCertificateBinding.mockResolvedValue({ valid: true, thumbprint: 'thumb' });
    const result = await redeem();
    expect(result.body.token_type).toBe('Bearer');
    expect(mocks.createAccessToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
    expect(mocks.createRefreshToken.mock.calls[0][0].cnf).toEqual({ 'x5t#S256': 'thumb' });
  });

  it('records no authentication context for a request without an authenticated acr', async () => {
    await redeem();
    expect(mocks.createRefreshTokenFamily.mock.calls[0][1]).not.toHaveProperty('authContext');
    expect(mocks.createIDToken.mock.calls[0][0]).not.toHaveProperty('nonce');
  });

  it('embeds no permissions when none are found, and evaluates none while off', async () => {
    mocks.isPolicyEmbeddingEnabled.mockResolvedValue(true);
    await redeem();
    expect(mocks.createAccessToken.mock.calls[0][0]).not.toHaveProperty('authrim_permissions');
    expect(mocks.createAccessToken.mock.calls[0][0]).not.toHaveProperty(
      'authrim_scoped_permissions'
    );

    env = resetHarness();
    mocks.getClientCached.mockResolvedValue(client());
    await redeem();
    expect(mocks.evaluatePermissionEmbeddingForScope).not.toHaveBeenCalled();
  });

  it('stores the refresh token itself when there is no rotator', async () => {
    env.REFRESH_TOKEN_ROTATOR = undefined as unknown as MockEnv['REFRESH_TOKEN_ROTATOR'];
    const result = await redeem();
    expect(result.status).toBe(200);
    expect(mocks.createRefreshTokenFamily).not.toHaveBeenCalled();
    const refreshJti = mocks.createRefreshToken.mock.calls[0][4] as string;
    expect(refreshJti).toMatch(/^rt_[0-9a-f-]{36}$/);
    const [, storedJti, stored, tenant] = mocks.storeRefreshToken.mock.calls[0];
    expect([storedJti, tenant]).toEqual([refreshJti, 'default']);
    expect(stored).toEqual({
      client_id: CLIENT_ID,
      sub: 'user-123',
      scope: SCOPE,
      resource_aud: RESOURCE,
      iat: expect.any(Number) as number,
      exp: expect.any(Number) as number,
      jti: refreshJti,
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
    const events = await publishedEvents(result.ctx);
    expect(events.map((event) => event.type)).toEqual(['token.access.issued', 'token.id.issued']);
  });

  it('issues for a request that carries no scope', async () => {
    const result = await redeem(metadata({ scope: undefined }));
    expect(result.status).toBe(200);
    expect(mocks.createRefreshTokenFamily.mock.calls[0][1].scope).toBe('');
    const events = await publishedEvents(result.ctx);
    expect(events[0].data.scopes).toEqual([]);
    expect(events[1].data.scopes).toEqual([]);
  });

  it('refuses a family whose consent was withdrawn while it was created', async () => {
    let reads = 0;
    mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) =>
      sql.includes('oauth_client_consent_revocations')
        ? { generation: reads++ === 0 ? 0 : 1, revoked_at: Date.now() - 60_000 }
        : null
    );
    env.REFRESH_TOKEN_ROTATOR.get = vi
      .fn()
      .mockReturnValue({ revokeFamilyIfFirstJtiRpc: vi.fn().mockResolvedValue(true) });
    const result = await redeem(metadata({ consent_generation: 0 }));
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: 'invalid_grant' });
    expect(mocks.recordRefreshTokenFamilyIndex).not.toHaveBeenCalled();
    expect(mocks.createRefreshToken).not.toHaveBeenCalled();
  });

  it('answers 500 when the ID token cannot be created', async () => {
    mocks.createIDToken.mockRejectedValue(new Error('signing failed'));
    const result = await redeem();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: 'server_error',
      error_description: 'Failed to create ID token',
    });
    expect(mocks.createRefreshTokenFamily).not.toHaveBeenCalled();
  });

  describe('ID token encryption', () => {
    const encryption = {
      id_token_encrypted_response_alg: 'RSA-OAEP-256',
      id_token_encrypted_response_enc: 'A256GCM',
    };

    it('answers 500 when the client has no encryption key', async () => {
      mocks.getClientCached.mockResolvedValue(client({ ...encryption, jwks: { keys: [] } }));
      const result = await redeem();
      expect(result.status).toBe(500);
      expect(result.body).toEqual({
        error: 'server_error',
        error_description: 'Client encryption key not available',
      });
    });

    it("encrypts the ID token to the client's key", async () => {
      const { publicKey } = await generateKeyPair('RSA-OAEP-256', { extractable: true });
      const jwk = { ...(await exportJWK(publicKey)), use: 'enc', alg: 'RSA-OAEP-256', kid: 'e1' };
      mocks.getClientCached.mockResolvedValue(client({ ...encryption, jwks: { keys: [jwk] } }));
      const result = await redeem();
      expect(result.status).toBe(200);
      const idToken = result.body.id_token as string;
      expect(idToken.split('.')).toHaveLength(5);
      const segment = idToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const header = JSON.parse(atob(segment)) as Record<string, unknown>;
      expect(header).toMatchObject({ alg: 'RSA-OAEP-256', enc: 'A256GCM' });
    });
  });
});
