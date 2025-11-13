/**
 * Tests for Dynamic Client Registration Handler
 * https://openid.net/specs/openid-connect-registration-1_0.html
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/types/env';
import { registerHandler } from '../../src/handlers/register';

// Mock environment
const mockEnv: Env = {
  ISSUER_URL: 'https://id.example.com',
  TOKEN_EXPIRY: '3600',
  CODE_EXPIRY: '120',
  STATE_EXPIRY: '300',
  NONCE_EXPIRY: '300',
  ALLOW_HTTP_REDIRECT: 'true',
  PRIVATE_KEY_PEM: 'mock-private-key',
  PUBLIC_JWK_JSON: '{"kty":"RSA"}',
  KEY_ID: 'test-key-id',
  AUTH_CODES: {} as KVNamespace,
  STATE_STORE: {} as KVNamespace,
  NONCE_STORE: {} as KVNamespace,
  CLIENTS: {} as KVNamespace,
  REVOKED_TOKENS: {} as KVNamespace,
};

// Mock KV storage
const mockKVStore = new Map<string, string>();

// Mock KV namespace with get, put, delete
const createMockKV = (): KVNamespace => {
  return {
    get: async (key: string) => mockKVStore.get(key) || null,
    put: async (key: string, value: string) => {
      mockKVStore.set(key, value);
    },
    delete: async (key: string) => {
      mockKVStore.delete(key);
    },
  } as unknown as KVNamespace;
};

describe('Dynamic Client Registration Handler', () => {
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    // Reset mock KV store
    mockKVStore.clear();

    // Create fresh app instance
    app = new Hono<{ Bindings: Env }>();
    app.post('/register', registerHandler);

    // Setup mock KV namespaces
    mockEnv.CLIENTS = createMockKV();
  });

  describe('Successful Registration', () => {
    it('should register a client with minimal required fields', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json).toHaveProperty('client_id');
      expect(json).toHaveProperty('client_secret');
      expect(json).toHaveProperty('client_id_issued_at');
      expect(json).toHaveProperty('client_secret_expires_at');
      expect(json.client_secret_expires_at).toBe(0); // Never expires
      expect(json.redirect_uris).toEqual(['https://example.com/callback']);
      expect(json.token_endpoint_auth_method).toBe('client_secret_basic'); // Default
      expect(json.grant_types).toEqual(['authorization_code']); // Default
      expect(json.response_types).toEqual(['code']); // Default
      expect(json.application_type).toBe('web'); // Default

      // Verify client_id format (base64url with prefix, ~135 characters total)
      expect(json.client_id).toMatch(/^client_[A-Za-z0-9_-]+$/);
      expect(json.client_id.length).toBeGreaterThanOrEqual(135); // 'client_' (7 chars) + ~128 chars

      // Verify client_secret is base64url encoded
      expect(json.client_secret).toMatch(/^[A-Za-z0-9_-]+$/);

      // Verify Cache-Control headers
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
    });

    it('should register a client with all optional fields', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback', 'https://example.com/callback2'],
        client_name: 'Test Application',
        client_uri: 'https://example.com',
        logo_uri: 'https://example.com/logo.png',
        contacts: ['admin@example.com', 'support@example.com'],
        tos_uri: 'https://example.com/tos',
        policy_uri: 'https://example.com/privacy',
        jwks_uri: 'https://example.com/.well-known/jwks.json',
        software_id: 'test-software-123',
        software_version: '1.0.0',
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        scope: 'openid profile email',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.client_name).toBe('Test Application');
      expect(json.client_uri).toBe('https://example.com');
      expect(json.logo_uri).toBe('https://example.com/logo.png');
      expect(json.contacts).toEqual(['admin@example.com', 'support@example.com']);
      expect(json.tos_uri).toBe('https://example.com/tos');
      expect(json.policy_uri).toBe('https://example.com/privacy');
      expect(json.jwks_uri).toBe('https://example.com/.well-known/jwks.json');
      expect(json.software_id).toBe('test-software-123');
      expect(json.software_version).toBe('1.0.0');
      expect(json.token_endpoint_auth_method).toBe('client_secret_post');
      expect(json.grant_types).toEqual(['authorization_code', 'refresh_token']);
      expect(json.response_types).toEqual(['code']);
      expect(json.application_type).toBe('native');
      expect(json.scope).toBe('openid profile email');
    });

    it('should store client metadata in KV', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        client_name: 'Test Client',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      const clientId = json.client_id;

      // Verify client was stored in KV
      const storedData = mockKVStore.get(clientId);
      expect(storedData).toBeDefined();

      const storedClient = JSON.parse(storedData!);
      expect(storedClient.client_id).toBe(clientId);
      expect(storedClient.client_name).toBe('Test Client');
      expect(storedClient.created_at).toBeDefined();
      expect(storedClient.updated_at).toBeDefined();
      expect(storedClient.created_at).toBe(storedClient.updated_at);
    });

    it('should accept http://localhost redirect_uri for development', async () => {
      const requestBody = {
        redirect_uris: ['http://localhost:3000/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.redirect_uris).toEqual(['http://localhost:3000/callback']);
    });
  });

  describe('Validation - redirect_uris', () => {
    it('should reject request without redirect_uris', async () => {
      const requestBody = {
        client_name: 'Test Client',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('redirect_uris is required');
    });

    it('should reject empty redirect_uris array', async () => {
      const requestBody = {
        redirect_uris: [],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('non-empty array');
    });

    it('should reject non-array redirect_uris', async () => {
      const requestBody = {
        redirect_uris: 'https://example.com/callback',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
    });

    it('should reject HTTP redirect_uri (except localhost)', async () => {
      const requestBody = {
        redirect_uris: ['http://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('HTTPS');
    });

    it('should reject redirect_uri with fragment identifier', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback#fragment'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('fragment');
    });

    it('should reject invalid URI format', async () => {
      const requestBody = {
        redirect_uris: ['not-a-valid-uri'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_redirect_uri');
      expect(json.error_description).toContain('Invalid URI');
    });
  });

  describe('Validation - Optional URI Fields', () => {
    it('should reject invalid client_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        client_uri: 'not-a-uri',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('client_uri');
    });

    it('should reject invalid logo_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        logo_uri: 'invalid-logo-uri',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('logo_uri');
    });

    it('should reject invalid jwks_uri', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        jwks_uri: 'not-valid',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
    });
  });

  describe('Validation - contacts', () => {
    it('should reject non-array contacts', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        contacts: 'admin@example.com',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('contacts must be an array');
    });

    it('should reject contacts with non-string values', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        contacts: ['admin@example.com', 123],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('All contacts must be strings');
    });
  });

  describe('Validation - token_endpoint_auth_method', () => {
    it('should accept valid token_endpoint_auth_method', async () => {
      const validMethods = ['client_secret_basic', 'client_secret_post', 'none'];

      for (const method of validMethods) {
        const requestBody = {
          redirect_uris: ['https://example.com/callback'],
          token_endpoint_auth_method: method,
        };

        const res = await app.request(
          '/register',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          },
          mockEnv
        );

        expect(res.status).toBe(201);

        const json = await res.json();
        expect(json.token_endpoint_auth_method).toBe(method);
      }
    });

    it('should reject invalid token_endpoint_auth_method', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        token_endpoint_auth_method: 'invalid_method',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('token_endpoint_auth_method');
    });
  });

  describe('Validation - application_type', () => {
    it('should accept valid application_type', async () => {
      const validTypes = ['web', 'native'];

      for (const type of validTypes) {
        const requestBody = {
          redirect_uris: ['https://example.com/callback'],
          application_type: type,
        };

        const res = await app.request(
          '/register',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
          },
          mockEnv
        );

        expect(res.status).toBe(201);

        const json = await res.json();
        expect(json.application_type).toBe(type);
      }
    });

    it('should reject invalid application_type', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        application_type: 'invalid',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('application_type');
    });
  });

  describe('Validation - grant_types', () => {
    it('should accept valid grant_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });

    it('should reject non-array grant_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: 'authorization_code',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('grant_types must be an array');
    });

    it('should reject unsupported grant_type', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code', 'client_credentials'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('Unsupported grant_type');
    });
  });

  describe('Validation - response_types', () => {
    it('should accept valid response_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.response_types).toEqual(['code']);
    });

    it('should reject non-array response_types', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: 'code',
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('response_types must be an array');
    });

    it('should reject unsupported response_type', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
        response_types: ['code', 'unsupported'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_client_metadata');
      expect(json.error_description).toContain('Unsupported response_type');
    });
  });

  describe('Error Handling', () => {
    it('should reject non-JSON request body', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: 'not-json',
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_request');
      expect(json.error_description).toContain('JSON object');
    });

    it('should reject null request body', async () => {
      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(null),
        },
        mockEnv
      );

      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe('invalid_request');
    });

    it('should handle missing Content-Type gracefully', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      // Should still work without Content-Type header
      expect(res.status).toBe(201);
    });
  });

  describe('Security', () => {
    it('should generate unique client_id for each registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res1 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const res2 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json1 = await res1.json();
      const json2 = await res2.json();

      expect(json1.client_id).not.toBe(json2.client_id);
    });

    it('should generate unique client_secret for each registration', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res1 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const res2 = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json1 = await res1.json();
      const json2 = await res2.json();

      expect(json1.client_secret).not.toBe(json2.client_secret);
    });

    it('should generate client_secret with sufficient length', async () => {
      const requestBody = {
        redirect_uris: ['https://example.com/callback'],
      };

      const res = await app.request(
        '/register',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
        mockEnv
      );

      const json = await res.json();

      // 32 bytes base64url encoded should be at least 40 characters
      expect(json.client_secret.length).toBeGreaterThanOrEqual(40);
    });
  });
});
