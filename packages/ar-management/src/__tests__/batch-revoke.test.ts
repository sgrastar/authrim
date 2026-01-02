import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import { batchRevokeHandler } from '../revoke';
import type { Env } from '@authrim/ar-lib-core';

// Type for batch revoke response
interface BatchRevokeResponse {
  error?: string;
  error_description?: string;
  summary?: {
    total: number;
    revoked: number;
    invalid: number;
  };
  results?: Array<{
    token_hint: string;
    status: 'revoked' | 'invalid';
  }>;
}

// Mock jose functions
vi.mock('jose', () => ({
  importJWK: vi.fn().mockResolvedValue({}),
  decodeProtectedHeader: vi.fn().mockReturnValue({ kid: 'test-kid' }),
}));

// Mock ar-lib-core functions
vi.mock('@authrim/ar-lib-core', async () => {
  const actual = await vi.importActual('@authrim/ar-lib-core');
  return {
    ...actual,
    validateClientId: vi.fn().mockReturnValue({ valid: true }),
    timingSafeEqual: vi.fn().mockReturnValue(true),
    createAuthContextFromHono: vi.fn().mockReturnValue({
      repositories: {
        client: {
          findByClientId: vi.fn().mockResolvedValue({
            client_id: 'test-client-id',
            client_secret: 'test-secret',
          }),
        },
      },
    }),
    getTenantIdFromContext: vi.fn().mockReturnValue('default'),
    parseToken: vi.fn().mockReturnValue({
      jti: 'test-jti',
      client_id: 'test-client-id',
      sub: 'test-user-id',
      aud: 'test-audience',
      rtv: 1,
    }),
    verifyToken: vi.fn().mockResolvedValue(undefined),
    revokeToken: vi.fn().mockResolvedValue(undefined),
    deleteRefreshToken: vi.fn().mockResolvedValue(undefined),
    getRefreshToken: vi.fn().mockResolvedValue(null),
    createOAuthConfigManager: vi.fn().mockReturnValue({
      getNumber: vi.fn().mockResolvedValue(3600),
    }),
    publishEvent: vi.fn().mockResolvedValue(undefined),
    TOKEN_EVENTS: {
      BATCH_REVOKED: 'token.batch.revoked',
      ACCESS_REVOKED: 'token.access.revoked',
      REFRESH_REVOKED: 'token.refresh.revoked',
    },
    createRFCErrorResponse: vi.fn().mockImplementation((_c, _code, status, message) => {
      return new Response(
        JSON.stringify({ error: 'invalid_request', error_description: message }),
        {
          status,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }),
    createErrorResponse: vi.fn().mockImplementation((_c, code) => {
      return new Response(JSON.stringify({ error: code }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  };
});

describe('Batch Revocation Handler', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockEnv: Partial<Env>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockEnv = {
      ISSUER_URL: 'https://auth.example.com',
      PUBLIC_JWK_JSON: JSON.stringify({ kty: 'RSA', n: 'test', e: 'AQAB' }),
      KV: {
        get: vi.fn().mockResolvedValue(null),
      } as unknown as KVNamespace,
      KEY_MANAGER: {
        idFromName: vi.fn().mockReturnValue({ toString: () => 'test-id' }),
        get: vi.fn().mockReturnValue({
          getAllPublicKeysRpc: vi
            .fn()
            .mockResolvedValue([{ kid: 'test-kid', kty: 'RSA', n: 'test', e: 'AQAB' }]),
        }),
      } as unknown as Env['KEY_MANAGER'],
      DB: {} as D1Database,
    };

    app = new Hono<{ Bindings: Env }>();
    app.post('/revoke/batch', batchRevokeHandler);
  });

  it('should return 400 for invalid Content-Type', async () => {
    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: 'tokens=test',
      },
      mockEnv
    );

    // Validation error after authentication passes
    expect(res.status).toBe(400);
    const json = (await res.json()) as BatchRevokeResponse;
    expect(json.error).toBe('invalid_request');
  });

  it('should return 400 for empty tokens array', async () => {
    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens: [] }),
      },
      mockEnv
    );

    // Validation error after authentication passes
    expect(res.status).toBe(400);
    const json = (await res.json()) as BatchRevokeResponse;
    expect(json.error).toBe('invalid_request');
  });

  it('should return 400 when tokens exceed max limit', async () => {
    // Set max tokens to 2 via KV
    (mockEnv.KV!.get as Mock).mockResolvedValue('2');

    const tokens = [{ token: 'token1' }, { token: 'token2' }, { token: 'token3' }];

    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens }),
      },
      mockEnv
    );

    // Validation error after authentication passes
    expect(res.status).toBe(400);
    const json = (await res.json()) as BatchRevokeResponse;
    expect(json.error).toBe('invalid_request');
  });

  it('should return 401 for missing client credentials', async () => {
    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ tokens: [{ token: 'test-token' }] }),
      },
      mockEnv
    );

    expect(res.status).toBe(401);
  });

  it('should successfully revoke multiple tokens', async () => {
    const { revokeToken, publishEvent } = await import('@authrim/ar-lib-core');

    const tokens = [
      { token: 'eyJhbGciOiJSUzI1NiJ9.test1', token_type_hint: 'access_token' as const },
      { token: 'eyJhbGciOiJSUzI1NiJ9.test2', token_type_hint: 'access_token' as const },
    ];

    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchRevokeResponse;

    expect(json.summary!.total).toBe(2);
    expect(json.results).toHaveLength(2);

    // Verify revokeToken was called
    expect(revokeToken).toHaveBeenCalled();

    // Verify event was published
    expect(publishEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'token.batch.revoked',
        data: expect.objectContaining({
          clientId: 'test-client-id',
          total: 2,
        }),
      })
    );
  });

  it('should handle mixed valid and invalid tokens', async () => {
    const { parseToken } = await import('@authrim/ar-lib-core');

    // First token valid, second token throws
    (parseToken as Mock)
      .mockReturnValueOnce({
        jti: 'valid-jti',
        client_id: 'test-client-id',
        sub: 'test-user-id',
        aud: 'test-audience',
      })
      .mockImplementationOnce(() => {
        throw new Error('Invalid token');
      });

    const tokens = [{ token: 'valid-token' }, { token: 'invalid-token' }];

    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchRevokeResponse;

    expect(json.summary!.total).toBe(2);
    // At least one should be invalid due to the mocked error
    expect(json.summary!.invalid).toBeGreaterThanOrEqual(1);
  });

  it('should reject tokens belonging to different clients', async () => {
    const { parseToken } = await import('@authrim/ar-lib-core');

    // Token belongs to different client
    (parseToken as Mock).mockReturnValue({
      jti: 'test-jti',
      client_id: 'other-client-id', // Different from requesting client
      sub: 'test-user-id',
      aud: 'test-audience',
    });

    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens: [{ token: 'other-client-token' }] }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchRevokeResponse;

    // Token should be marked as invalid (not owned by requesting client)
    expect(json.summary!.invalid).toBe(1);
    expect(json.summary!.revoked).toBe(0);
  });

  it('should handle refresh token with cascade revocation', async () => {
    const { deleteRefreshToken, revokeToken, getRefreshToken, parseToken } = await import(
      '@authrim/ar-lib-core'
    );

    // Reset parseToken to return correct client_id
    (parseToken as Mock).mockReturnValue({
      jti: 'refresh-jti',
      client_id: 'test-client-id',
      sub: 'test-user-id',
      aud: 'test-audience',
      rtv: 1,
    });

    // Mock refresh token exists
    (getRefreshToken as Mock).mockResolvedValue({ familyId: 'test-family' });

    const tokens = [
      { token: 'eyJhbGciOiJSUzI1NiJ9.refresh-token', token_type_hint: 'refresh_token' as const },
    ];

    const res = await app.request(
      '/revoke/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + btoa('test-client-id:test-secret'),
        },
        body: JSON.stringify({ tokens }),
      },
      mockEnv
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as BatchRevokeResponse;

    // Should be marked as revoked
    expect(json.summary!.revoked).toBe(1);

    // Verify both deleteRefreshToken and revokeToken (cascade) were called
    expect(deleteRefreshToken).toHaveBeenCalled();
    expect(revokeToken).toHaveBeenCalled(); // Cascade revocation
  });
});
