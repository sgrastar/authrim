/**
 * JWT bearer grant (RFC 7523 section 2.1): the signed assertion is the authority; the request
 * may only narrow its scope and target. The issued access token, event and response.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  mocks,
  resetHarness,
  callToken,
  publishedEvents,
  JWT_BEARER_GRANT,
} from './helpers/mut-grants-harness';
import { createMockDurableObjectNamespace, type MockEnv } from './helpers/mocks';
import { tokenHandler } from '../token';

const ISSUER = 'https://service.example.com';
const API = 'svc://service-api';
const ADMIN_API = 'svc://service-admin-api';

function trustIssuer(policy: Record<string, unknown> = {}) {
  mocks.parseTrustedIssuers.mockReturnValue(
    new Map([
      [
        ISSUER,
        {
          issuer: ISSUER,
          jwks_uri: `${ISSUER}/jwks`,
          default_resource: API,
          allowed_resources: [API, ADMIN_API],
          ...policy,
        },
      ],
    ])
  );
}

function assertionClaims(claims: Record<string, unknown> = {}) {
  mocks.validateJWTBearerAssertion.mockResolvedValue({
    valid: true,
    claims: {
      iss: ISSUER,
      sub: 'service-account',
      aud: 'https://auth.example.com/token',
      scope: 'api:read api:write',
      resource: [API, ADMIN_API],
      ...claims,
    },
  });
}

describe('JWT bearer grant', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = resetHarness();
    trustIssuer();
    assertionClaims();
  });

  function request(params: Record<string, string> = {}) {
    return callToken(tokenHandler, env, {
      grant_type: JWT_BEARER_GRANT,
      assertion: 'signed-assertion',
      ...params,
    });
  }

  describe('a refused assertion', () => {
    it("answers with the validator's error and description", async () => {
      mocks.validateJWTBearerAssertion.mockResolvedValue({
        valid: false,
        error: 'invalid_client',
        error_description: 'Assertion signature is invalid',
      });
      const result = await request();
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_client',
        error_description: 'Assertion signature is invalid',
      });
    });

    it('answers invalid_grant with a generic description when the validator gives none', async () => {
      mocks.validateJWTBearerAssertion.mockResolvedValue({ valid: false });
      const result = await request();
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_grant',
        error_description: 'JWT assertion validation failed',
      });
    });
  });

  describe('scope', () => {
    it('grants the assertion scope when none is requested', async () => {
      const result = await request();
      expect(result.status).toBe(200);
      expect(result.body.scope).toBe('api:read api:write');
    });

    it('narrows the scope to the requested subset', async () => {
      const result = await request({ scope: 'api:write' });
      expect(result.status).toBe(200);
      expect(result.body.scope).toBe('api:write');
      expect(mocks.createAccessToken.mock.calls[0][0].scope).toBe('api:write');
    });

    it('refuses a scope beyond the assertion', async () => {
      const result = await request({ scope: 'api:read api:delete' });
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_scope',
        error_description: 'Requested scope exceeds the JWT assertion',
      });
      expect(mocks.createAccessToken).not.toHaveBeenCalled();
    });

    it("issues several scopes that are all within the issuer's allowed scopes", async () => {
      trustIssuer({ allowed_scopes: ['api:read', 'api:write'] });
      const result = await request();
      expect(result.status).toBe(200);
      expect(result.body.scope).toBe('api:read api:write');
    });

    it("refuses when any granted scope is outside the issuer's allowed scopes", async () => {
      trustIssuer({ allowed_scopes: ['api:read'] });
      const result = await request();
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_scope',
        error_description: 'Requested scope is not allowed for this issuer',
      });
    });
  });

  describe('target', () => {
    it('defaults the audience to the resource the assertion names', async () => {
      assertionClaims({ resource: ADMIN_API });
      const result = await request();
      expect(result.status).toBe(200);
      expect(mocks.createAccessToken.mock.calls[0][0].aud).toBe(ADMIN_API);
    });

    it('issues for an audience the assertion names', async () => {
      assertionClaims({ resource: ADMIN_API });
      const result = await request({ audience: ADMIN_API });
      expect(result.status).toBe(200);
      const aud = mocks.createAccessToken.mock.calls[0][0].aud as string | string[];
      expect(new Set([aud].flat())).toEqual(new Set([ADMIN_API]));
    });

    it.each([
      ['resource', { resource: 'svc://other-api' }],
      ['audience', { audience: 'svc://other-api' }],
    ])('refuses a requested %s the assertion does not name', async (_label, params) => {
      const result = await request(params);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({
        error: 'invalid_target',
        error_description: 'Requested target exceeds the JWT assertion',
      });
    });

    it('refuses a resource and an audience that name different targets', async () => {
      const result = await request({ resource: API, audience: ADMIN_API });
      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ error: 'invalid_target' });
      expect(mocks.createAccessToken).not.toHaveBeenCalled();
    });
  });

  it('answers 503 when the security requirements cannot be read', async () => {
    (env as unknown as { SETTINGS: unknown }).SETTINGS = {
      get: vi.fn().mockRejectedValue(new Error('settings store down')),
    };
    const result = await request();
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ error: 'temporarily_unavailable' });
    expect(mocks.createAccessToken).not.toHaveBeenCalled();
  });

  it('answers 500 when no signing key can be loaded', async () => {
    env.AUTHRIM_CONFIG.get = vi.fn().mockResolvedValue('rotated-key-version');
    env.KEY_MANAGER = createMockDurableObjectNamespace({
      rpcMethods: {
        getActiveKeyWithPrivateRpc: vi.fn().mockRejectedValue(new Error('key manager down')),
      },
    });
    const result = await request();
    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: 'server_error',
      error_description: 'Failed to load signing key',
    });
  });

  it('issues a Bearer access token for the asserted subject and publishes it', async () => {
    assertionClaims({ resource: API });
    const result = await request({ scope: 'api:read' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      access_token: 'mock-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'api:read',
    });
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(result.headers.get('Pragma')).toBe('no-cache');
    expect(mocks.createAccessToken.mock.calls[0][0]).toMatchObject({
      iss: 'https://auth.example.com',
      sub: 'service-account',
      aud: API,
      scope: 'api:read',
      client_id: ISSUER,
    });
    const events = await publishedEvents(result.ctx);
    expect(events).toEqual([
      {
        type: 'token.access.issued',
        tenantId: 'default',
        data: {
          jti: 'at-jti-001',
          clientId: ISSUER,
          userId: 'service-account',
          scopes: ['api:read'],
          expiresAt: expect.any(Number) as number,
          grantType: JWT_BEARER_GRANT,
        },
      },
    ]);
    const remaining = (events[0].data.expiresAt as number) - Math.floor(Date.now() / 1000);
    expect(remaining).toBeGreaterThan(3500);
    expect(remaining).toBeLessThanOrEqual(3600);
  });
});
