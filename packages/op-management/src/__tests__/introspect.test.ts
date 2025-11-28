/**
 * Token Introspection Endpoint Unit Tests
 *
 * Tests for OAuth 2.0 Token Introspection (RFC 7662)
 * Security-focused tests for token validation, client authentication,
 * and proper introspection responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/shared';

// Mock the shared module
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    validateClientId: vi.fn(),
    timingSafeEqual: vi.fn((a: string, b: string) => a === b),
    getRefreshToken: vi.fn(),
    isTokenRevoked: vi.fn(),
    parseToken: vi.fn(),
    verifyToken: vi.fn(),
  };
});

// Mock jose
vi.mock('jose', () => ({
  importJWK: vi.fn(),
}));

import { introspectHandler } from '../introspect';
import {
  validateClientId,
  timingSafeEqual,
  getRefreshToken,
  isTokenRevoked,
  parseToken,
  verifyToken,
} from '@authrim/shared';
import { importJWK } from 'jose';

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, string>;
  env?: Partial<Env>;
}) {
  const mockEnv: Partial<Env> = {
    PUBLIC_JWK_JSON: JSON.stringify({
      kty: 'RSA',
      kid: 'key-1',
      n: 'mock-n',
      e: 'AQAB',
    }),
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn(),
        }),
      }),
    } as unknown as D1Database,
    ...options.env,
  };

  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'POST',
      parseBody: vi.fn().mockResolvedValue(options.body || {}),
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
  } as any;

  return c;
}

// Sample token payload for testing
const sampleTokenPayload = {
  jti: 'token-jti-123',
  sub: 'user-123',
  aud: 'https://op.example.com',
  scope: 'openid profile email',
  iss: 'https://op.example.com',
  exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
  iat: Math.floor(Date.now() / 1000),
  client_id: 'client-123',
};

describe('Token Introspection Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importJWK).mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Content-Type Validation', () => {
    it('should reject requests without application/x-www-form-urlencoded Content-Type', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          token: 'some-token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('application/x-www-form-urlencoded'),
        }),
        400
      );
    });

    it('should accept application/x-www-form-urlencoded with charset', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });
  });

  describe('Token Parameter Validation', () => {
    it('should return 400 when token parameter is missing', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'token parameter is required',
        }),
        400
      );
    });
  });

  describe('Client Authentication', () => {
    it('should authenticate client using HTTP Basic', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + btoa('client-123:client-secret'),
        },
        body: {
          token: 'valid.jwt.token',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should authenticate client using form body', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should return 401 when client_id is invalid', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'invalid-client-id!!!',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({
        valid: false,
        error: 'Invalid client_id format',
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
        }),
        401
      );
    });

    it('should return 401 when client is not found', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'nonexistent-client',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Client not found',
        }),
        401
      );
    });

    it('should return 401 when client_secret is incorrect', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'wrong-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(timingSafeEqual).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'correct-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        }),
        401
      );
    });

    it('should use timing-safe comparison for client_secret', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(timingSafeEqual).mockReturnValue(true);
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(timingSafeEqual).toHaveBeenCalledWith('client-secret', 'client-secret');
    });

    it('should return 401 for invalid Basic auth header format', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic invalid-base64!!!',
        },
        body: {
          token: 'valid.jwt.token',
        },
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client',
        }),
        401
      );
    });
  });

  describe('Token Introspection Response', () => {
    it('should return active=true for valid token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
          scope: 'openid profile email',
          client_id: 'client-123',
          token_type: 'Bearer',
          sub: 'user-123',
          iss: 'https://op.example.com',
          jti: 'token-jti-123',
        })
      );
    });

    it('should return active=false for invalid token format', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'invalid-token-format',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockImplementation(() => {
        throw new Error('Invalid token format');
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for expired token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'expired.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue({
        ...sampleTokenPayload,
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
      });
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for revoked token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'revoked.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(true); // Token is revoked

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should return active=false for token with invalid signature', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'tampered.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockRejectedValue(new Error('Invalid signature'));

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });
  });

  describe('Token Type Hint Handling', () => {
    it('should check refresh token storage when token_type_hint is refresh_token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'refresh.token.value',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue({
        familyId: 'family-123',
        tokenId: 'token-jti-123',
      } as any);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(getRefreshToken).toHaveBeenCalledWith(c.env, 'token-jti-123', 'client-123');
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });

    it('should return active=false for non-existent refresh token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'nonexistent.refresh.token',
          token_type_hint: 'refresh_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(getRefreshToken).mockResolvedValue(null); // Refresh token not found

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith({ active: false });
    });

    it('should check revocation status when token_type_hint is access_token', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'access.token.value',
          token_type_hint: 'access_token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);
      vi.mocked(verifyToken).mockResolvedValue(sampleTokenPayload);
      vi.mocked(isTokenRevoked).mockResolvedValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(isTokenRevoked).toHaveBeenCalledWith(c.env, 'token-jti-123');
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          active: true,
        })
      );
    });
  });

  describe('Server Configuration Errors', () => {
    it('should return 500 when PUBLIC_JWK_JSON is missing', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          PUBLIC_JWK_JSON: undefined, // Missing
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Server configuration error',
        }),
        500
      );
    });

    it('should return 500 when PUBLIC_JWK_JSON is invalid', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'valid.jwt.token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
        env: {
          PUBLIC_JWK_JSON: 'invalid-json{{{',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockReturnValue(sampleTokenPayload);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Failed to load verification key',
        }),
        500
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle body parsing errors', async () => {
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {},
      });

      c.req.parseBody = vi.fn().mockRejectedValue(new Error('Parse error'));

      await introspectHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Failed to parse request body',
        }),
        400
      );
    });
  });

  describe('Security - Information Disclosure Prevention', () => {
    it('should return same response structure for valid and invalid tokens', async () => {
      // Both valid and invalid tokens should return { active: false }
      // without revealing why the token is invalid
      const c = createMockContext({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: {
          token: 'invalid-token',
          client_id: 'client-123',
          client_secret: 'client-secret',
        },
      });

      vi.mocked(validateClientId).mockReturnValue({ valid: true });
      vi.mocked(parseToken).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            client_id: 'client-123',
            client_secret: 'client-secret',
          }),
        }),
      });

      await introspectHandler(c);

      // Should just return { active: false } without error details
      expect(c.json).toHaveBeenCalledWith({ active: false });
    });
  });
});
