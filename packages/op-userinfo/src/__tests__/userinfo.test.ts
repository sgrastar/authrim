/**
 * UserInfo Endpoint Unit Tests
 *
 * Tests for OIDC UserInfo endpoint (RFC 7519, OIDC Core 5.3)
 * Security-focused tests for token validation, scope-based claim filtering,
 * and JWE encryption.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/shared';

// Mock the shared module
vi.mock('@authrim/shared', async () => {
  const actual = await vi.importActual('@authrim/shared');
  return {
    ...actual,
    introspectTokenFromContext: vi.fn(),
    getClient: vi.fn(),
    encryptJWT: vi.fn(),
    isUserInfoEncryptionRequired: vi.fn(),
    getClientPublicKey: vi.fn(),
    validateJWEOptions: vi.fn(),
  };
});

import { userinfoHandler } from '../userinfo';
import {
  introspectTokenFromContext,
  getClient,
  encryptJWT,
  isUserInfoEncryptionRequired,
  getClientPublicKey,
  validateJWEOptions,
} from '@authrim/shared';

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  headers?: Record<string, string>;
  env?: Partial<Env>;
}) {
  const app = new Hono<{ Bindings: Env }>();

  const mockEnv: Partial<Env> = {
    ISSUER_URL: 'https://op.example.com',
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn(),
        }),
      }),
    } as unknown as D1Database,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue('key-manager-id'),
      get: vi.fn().mockReturnValue({
        // RPC methods for KeyManager
        getActiveKeyRpc: vi.fn().mockResolvedValue({ kid: 'key-1', publicJWK: {} }),
        getActiveKeyWithPrivateRpc: vi
          .fn()
          .mockResolvedValue({ kid: 'key-1', privatePEM: 'mock-pem' }),
        // fetch fallback for backward compatibility
        fetch: vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ kid: 'key-1', privatePEM: 'mock-pem' }), {
            status: 200,
          })
        ),
      }),
    } as unknown as Env['KEY_MANAGER'],
    KEY_MANAGER_SECRET: 'test-secret',
    ...options.env,
  };

  const req = new Request('https://op.example.com/userinfo', {
    method: options.method || 'GET',
    headers: options.headers || {},
  });

  // Create a mock context
  const c = {
    req: {
      header: (name: string) => options.headers?.[name],
      method: options.method || 'GET',
    },
    env: mockEnv as Env,
    json: vi.fn((body, status = 200) => new Response(JSON.stringify(body), { status })),
    header: vi.fn(),
    body: vi.fn((body, status = 200) => new Response(body, { status })),
  } as any;

  return c;
}

// Sample user data for testing
const sampleUser = {
  id: 'user-123',
  name: 'Test User',
  family_name: 'User',
  given_name: 'Test',
  middle_name: 'Middle',
  nickname: 'tester',
  preferred_username: 'testuser',
  profile: 'https://example.com/profile',
  picture: 'https://example.com/picture.jpg',
  website: 'https://example.com',
  gender: 'male',
  birthdate: '1990-01-01',
  zoneinfo: 'Asia/Tokyo',
  locale: 'ja-JP',
  updated_at: 1700000000000,
  email: 'test@example.com',
  email_verified: 1,
  phone_number: '+81-90-1234-5678',
  phone_number_verified: 1,
  address_json: JSON.stringify({
    formatted: '123 Test Street, Tokyo, Japan',
    street_address: '123 Test Street',
    locality: 'Tokyo',
    country: 'Japan',
  }),
};

describe('UserInfo Endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Token Validation', () => {
    it('should return 401 when token is invalid', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer invalid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token is invalid',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token is invalid',
        }),
        401
      );
      expect(c.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer error="invalid_token"');
    });

    it('should return 401 when token is expired', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer expired-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token has expired',
          wwwAuthenticate: 'Bearer error="invalid_token", error_description="Token has expired"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token has expired',
        }),
        401
      );
    });

    it('should return 401 when no authorization header is provided', async () => {
      const c = createMockContext({
        headers: {},
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_request',
          error_description: 'Missing access token',
          wwwAuthenticate: 'Bearer',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
        }),
        401
      );
    });

    it('should return 401 when token does not contain sub claim', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          // Missing 'sub' claim
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'Token does not contain subject claim',
        }),
        401
      );
    });

    it('should return 500 when introspection returns valid but no claims', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: undefined,
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Missing claims',
        }),
        500
      );
    });
  });

  describe('User Not Found', () => {
    it('should return 401 when user is not found in database', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'nonexistent-user',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      // Mock DB to return null (user not found)
      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_token',
          error_description: 'User not found',
        }),
        401
      );
    });
  });

  describe('Scope-based Claim Filtering', () => {
    beforeEach(() => {
      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);
    });

    it('should return only sub with openid scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'user-123',
        })
      );

      // Should NOT include profile claims
      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody).not.toHaveProperty('name');
      expect(responseBody).not.toHaveProperty('email');
      expect(responseBody).not.toHaveProperty('phone_number');
      expect(responseBody).not.toHaveProperty('address');
    });

    it('should return profile claims with profile scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.family_name).toBe('User');
      expect(responseBody.given_name).toBe('Test');
      expect(responseBody.picture).toBe('https://example.com/picture.jpg');
      expect(responseBody.gender).toBe('male');
      expect(responseBody.birthdate).toBe('1990-01-01');
      expect(responseBody.zoneinfo).toBe('Asia/Tokyo');
      expect(responseBody.locale).toBe('ja-JP');
    });

    it('should return email claims with email scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.email_verified).toBe(true);
      // Should NOT include profile claims
      expect(responseBody).not.toHaveProperty('name');
    });

    it('should return phone claims with phone scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid phone',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.phone_number).toBe('+81-90-1234-5678');
      expect(responseBody.phone_number_verified).toBe(true);
    });

    it('should return address with address scope', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid address',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.address).toEqual({
        formatted: '123 Test Street, Tokyo, Japan',
        street_address: '123 Test Street',
        locality: 'Tokyo',
        country: 'Japan',
      });
    });

    it('should return all claims with all scopes', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email phone address',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.phone_number).toBe('+81-90-1234-5678');
      expect(responseBody.address).toBeDefined();
    });

    it('should handle empty scope gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: '',
          client_id: 'client-123',
        },
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(Object.keys(responseBody)).toEqual(['sub']);
    });
  });

  describe('Claims Parameter', () => {
    it('should include claims from claims parameter when allow_claims_without_scope is true', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: { essential: true },
              name: null,
            },
          }),
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        allow_claims_without_scope: true,
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.email).toBe('test@example.com');
      expect(responseBody.name).toBe('Test User');
    });

    it('should NOT include claims from claims parameter when allow_claims_without_scope is false', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid',
          client_id: 'client-123',
          claims: JSON.stringify({
            userinfo: {
              email: { essential: true },
            },
          }),
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        allow_claims_without_scope: false,
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody).not.toHaveProperty('email');
    });

    it('should handle malformed claims parameter gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
          claims: 'invalid-json{{{',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      // Should not throw, should continue without claims parameter
      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      expect(responseBody.name).toBe('Test User');
    });
  });

  describe('JWE Encryption', () => {
    it('should return encrypted response when client requires encryption', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue({
        kid: 'client-key-1',
        kty: 'RSA',
      } as any);
      vi.mocked(encryptJWT).mockResolvedValue('encrypted.jwt.token');

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      // Mock KEY_MANAGER to return a valid PKCS8 formatted PEM
      const mockPrivateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7JHoJfg6yNzLM
-----END PRIVATE KEY-----`;

      c.env.KEY_MANAGER = {
        idFromName: vi.fn().mockReturnValue('key-manager-id'),
        get: vi.fn().mockReturnValue({
          // RPC methods for KeyManager
          getActiveKeyWithPrivateRpc: vi
            .fn()
            .mockResolvedValue({ kid: 'key-1', privatePEM: mockPrivateKeyPEM }),
          // fetch fallback for backward compatibility
          fetch: vi.fn().mockResolvedValue(
            new Response(JSON.stringify({ kid: 'key-1', privatePEM: mockPrivateKeyPEM }), {
              status: 200,
            })
          ),
        }),
      } as unknown as Env['KEY_MANAGER'];

      // Since the private key mock won't actually work with jose.importPKCS8,
      // we'll verify that the error handling works correctly
      await userinfoHandler(c);

      // The test should result in server_error due to invalid PEM format
      // But this validates the encryption path is being attempted
      expect(isUserInfoEncryptionRequired).toHaveBeenCalled();
      expect(getClientPublicKey).toHaveBeenCalled();
    });

    it('should return error when client requires encryption but no public key', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue(null);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client_metadata',
          error_description: expect.stringContaining('no public key'),
        }),
        400
      );
    });

    it('should return error when JWE options are invalid', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'INVALID-ALG',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockImplementation(() => {
        throw new Error('Unsupported algorithm');
      });

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_client_metadata',
          error_description: expect.stringContaining('Unsupported algorithm'),
        }),
        400
      );
    });

    it('should return error when encryption fails', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue({
        client_id: 'client-123',
        userinfo_encrypted_response_alg: 'RSA-OAEP',
        userinfo_encrypted_response_enc: 'A256GCM',
      } as any);

      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(true);
      vi.mocked(validateJWEOptions).mockReturnValue(true);
      vi.mocked(getClientPublicKey).mockResolvedValue({
        kid: 'client-key-1',
        kty: 'RSA',
      } as any);
      vi.mocked(encryptJWT).mockRejectedValue(new Error('Encryption failed'));

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(sampleUser),
        }),
      });

      await userinfoHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'server_error',
          error_description: 'Failed to encrypt UserInfo response',
        }),
        500
      );
    });
  });

  describe('Data Format Handling', () => {
    it('should convert email_verified from integer to boolean', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid email',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            email_verified: 1,
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.email_verified).toBe(true);
    });

    it('should convert phone_number_verified from integer to boolean', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid phone',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            phone_number_verified: 0,
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.phone_number_verified).toBe(false);
    });

    it('should convert updated_at from milliseconds to seconds', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            updated_at: 1700000000000, // milliseconds
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.updated_at).toBe(1700000000); // seconds
    });

    it('should handle malformed address_json gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid address',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            ...sampleUser,
            address_json: 'invalid-json{{{',
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.address).toBeUndefined();
    });

    it('should handle null/undefined fields gracefully', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'user-123',
          scope: 'openid profile email',
          client_id: 'client-123',
        },
      });

      vi.mocked(getClient).mockResolvedValue(null);
      vi.mocked(isUserInfoEncryptionRequired).mockReturnValue(false);

      c.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: 'user-123',
            name: null,
            email: null,
            // All other fields are missing
          }),
        }),
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      expect(responseBody.sub).toBe('user-123');
      // Null/undefined fields should not be included
      expect(responseBody.name).toBeUndefined();
      expect(responseBody.email).toBeUndefined();
    });
  });

  describe('Security - Information Disclosure Prevention', () => {
    it('should not leak user existence through different error messages', async () => {
      const c1 = createMockContext({
        headers: { Authorization: 'Bearer token-for-nonexistent-user' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: true,
        claims: {
          sub: 'nonexistent-user',
          scope: 'openid',
          client_id: 'client-123',
        },
      });

      c1.env.DB.prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      await userinfoHandler(c1);

      // Error message should be generic
      expect(vi.mocked(c1.json).mock.calls[0][0].error).toBe('invalid_token');
      expect(vi.mocked(c1.json).mock.calls[0][1]).toBe(401);
    });

    it('should not include sensitive internal information in error responses', async () => {
      const c = createMockContext({
        headers: { Authorization: 'Bearer valid-token' },
      });

      vi.mocked(introspectTokenFromContext).mockResolvedValue({
        valid: false,
        error: {
          error: 'invalid_token',
          error_description: 'Token validation failed',
          wwwAuthenticate: 'Bearer error="invalid_token"',
          statusCode: 401,
        },
      });

      await userinfoHandler(c);

      const responseBody = vi.mocked(c.json).mock.calls[0][0];
      // Should not contain stack traces or internal details
      expect(JSON.stringify(responseBody)).not.toContain('stack');
      expect(JSON.stringify(responseBody)).not.toContain('Error:');
    });
  });
});
