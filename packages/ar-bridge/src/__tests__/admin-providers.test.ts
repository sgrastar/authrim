/**
 * Admin API Provider Management Unit Tests
 * Tests for provider CRUD operations via Admin API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  handleAdminListProviders,
  handleAdminCreateProvider,
  handleAdminGetProvider,
  handleAdminUpdateProvider,
  handleAdminDeleteProvider,
} from '../admin/providers';

// Define Env type locally to avoid importing from @authrim/ar-lib-core
// which has cloudflare:workers dependencies
interface Env {
  RP_TOKEN_ENCRYPTION_KEY?: string;
  DB?: D1Database;
  SETTINGS?: KVNamespace;
  [key: string]: unknown;
}

// Mock @authrim/ar-lib-core to avoid cloudflare:workers dependency
vi.mock('@authrim/ar-lib-core', () => {
  // Map AR error codes to status and RFC error
  const errorMappings: Record<string, { status: number; rfcError: string }> = {
    AR900001: { status: 500, rfcError: 'server_error' }, // INTERNAL_ERROR
    AR060001: { status: 401, rfcError: 'invalid_request' }, // ADMIN_AUTH_REQUIRED
    AR060002: { status: 403, rfcError: 'insufficient_scope' }, // ADMIN_INSUFFICIENT_PERMISSIONS
    AR020002: { status: 404, rfcError: 'invalid_request' }, // CLIENT_NOT_FOUND
    AR060004: { status: 404, rfcError: 'invalid_request' }, // ADMIN_RESOURCE_NOT_FOUND
    AR010001: { status: 400, rfcError: 'invalid_request' }, // VALIDATION_REQUIRED_FIELD
    AR010002: { status: 400, rfcError: 'invalid_request' }, // VALIDATION_INVALID_VALUE
  };

  // Mock logger
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  return {
    ADMIN_PERMISSIONS: {
      EXTERNAL_PROVIDERS_READ: 'admin:external_providers:read',
      EXTERNAL_PROVIDERS_WRITE: 'admin:external_providers:write',
      EXTERNAL_PROVIDERS_DELETE: 'admin:external_providers:delete',
    },
    AR_ERROR_CODES: {
      INTERNAL_ERROR: 'AR900001',
      ADMIN_AUTH_REQUIRED: 'AR060001',
      ADMIN_INSUFFICIENT_PERMISSIONS: 'AR060002',
      CLIENT_NOT_FOUND: 'AR020002',
      ADMIN_RESOURCE_NOT_FOUND: 'AR060004',
      VALIDATION_REQUIRED_FIELD: 'AR010001',
      VALIDATION_INVALID_VALUE: 'AR010002',
    },
    RFC_ERROR_CODES: {
      INVALID_REQUEST: 'invalid_request',
      SERVER_ERROR: 'server_error',
    },
    createErrorResponse: async (_c: unknown, code: string) => {
      const mapping = errorMappings[code] || { status: 500, rfcError: 'server_error' };
      return new Response(
        JSON.stringify({
          error: mapping.rfcError,
          error_description: `Error: ${code}`,
        }),
        { status: mapping.status, headers: { 'Content-Type': 'application/json' } }
      );
    },
    createRFCErrorResponse: async (
      _c: unknown,
      rfcError: string,
      status: number,
      detail?: string
    ) => {
      return new Response(
        JSON.stringify({
          error: rfcError,
          error_description: detail || rfcError,
        }),
        { status, headers: { 'Content-Type': 'application/json' } }
      );
    },
    getLogger: () => ({
      module: () => mockLogger,
    }),
    createLogger: () => ({
      module: () => mockLogger,
    }),
    getTenantIdFromContext: vi.fn((c: { get?: (key: string) => string | undefined }) => {
      return c.get?.('tenantId') || 'default';
    }),
    hasAdminPermission: (permissions: string[], required: string) => {
      if (permissions.includes('*')) return true;
      if (permissions.includes(required)) return true;
      const parts = required.split(':');
      for (let i = parts.length - 1; i >= 0; i--) {
        if (permissions.includes([...parts.slice(0, i), '*'].join(':'))) {
          return true;
        }
      }
      return false;
    },
    validateWebhookUrl: vi.fn((value: string) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
          return { valid: false, error: 'Webhook URL must use HTTPS' };
        }
        if (url.hostname === '169.254.169.254' || url.hostname === '127.0.0.1') {
          return { valid: false, error: 'Blocked IP range' };
        }
        return { valid: true, parsedUrl: url };
      } catch {
        return { valid: false, error: 'Invalid URL format' };
      }
    }),
  };
});

// Mock provider-store module
vi.mock('../services/provider-store', () => ({
  listAllProviders: vi.fn(),
  getProvider: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
}));

// Mock crypto module
vi.mock('../utils/crypto', () => ({
  encrypt: vi.fn().mockResolvedValue('encrypted-secret'),
  getEncryptionKey: vi.fn().mockReturnValue('mock-encryption-key'),
}));

import * as providerStore from '../services/provider-store';
import * as cryptoUtils from '../utils/crypto';

describe('Admin Provider API', () => {
  const mockEnv: Partial<Env> = {
    RP_TOKEN_ENCRYPTION_KEY: 'test-encryption-key',
  };

  const createMockContext = (
    method: string,
    path: string,
    options: {
      headers?: Record<string, string>;
      body?: unknown;
      params?: Record<string, string>;
      query?: Record<string, string>;
      tenantId?: string;
      authenticated?: boolean;
      permissions?: string[];
    } = {}
  ) => {
    const url = new URL(`http://localhost${path}`);
    if (options.query) {
      Object.entries(options.query).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    return {
      req: {
        method,
        header: (name: string) => options.headers?.[name],
        param: (name: string) => options.params?.[name],
        query: (name: string) => options.query?.[name],
        json: async () => options.body,
      },
      env: mockEnv as Env,
      get: (name: string) => {
        if (name === 'tenantId') {
          return options.tenantId || 'default';
        }
        if (name === 'adminAuth' && options.authenticated !== false) {
          return {
            userId: 'admin-1',
            actorId: 'admin-1',
            actorType: 'admin_user',
            authMethod: 'session',
            permissions: options.permissions ?? ['*'],
          };
        }
        return undefined;
      },
      json: vi.fn().mockImplementation((data, status = 200) => {
        return new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      redirect: vi.fn(),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication', () => {
    it('should reject requests without Authorization header', async () => {
      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        authenticated: false,
      });
      const response = await handleAdminListProviders(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should reject requests with invalid token', async () => {
      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer wrong-token' },
        authenticated: false,
      });
      const response = await handleAdminListProviders(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should reject requests with non-Bearer auth', async () => {
      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Basic test-admin-secret' },
        authenticated: false,
      });
      const response = await handleAdminListProviders(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should accept requests with valid admin token', async () => {
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce([]);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
      });
      await handleAdminListProviders(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ providers: [] });
    });
  });

  describe('handleAdminListProviders', () => {
    it('should list all providers', async () => {
      const mockProviders = [
        {
          id: 'provider-1',
          name: 'Google',
          providerType: 'oidc',
          clientSecretEncrypted: 'encrypted',
        },
        {
          id: 'provider-2',
          name: 'Microsoft',
          providerType: 'oidc',
          clientSecretEncrypted: 'encrypted',
        },
      ];
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce(mockProviders as never);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
      });
      await handleAdminListProviders(ctx as never);

      expect(ctx.json).toHaveBeenCalled();
      const callArgs = vi.mocked(ctx.json).mock.calls[0][0] as {
        providers: Array<{ clientSecretEncrypted?: string; hasSecret?: boolean }>;
      };
      expect(callArgs.providers).toHaveLength(2);
      // Ensure secrets are removed
      callArgs.providers.forEach((p) => {
        expect(p.clientSecretEncrypted).toBeUndefined();
        expect(p.hasSecret).toBe(true);
      });
    });

    it('does not return Apple private keys in provider responses', async () => {
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce([
        {
          id: 'apple-provider',
          name: 'Apple',
          clientSecretEncrypted: 'encrypted-client-secret',
          privateKeyJwkEncrypted: 'encrypted-request-object-key',
          providerQuirks: {
            teamId: 'TEAMID1234',
            keyId: 'KEYID12345',
            privateKeyEncrypted: 'encrypted-private-key',
          },
        },
      ] as never);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
      });
      await handleAdminListProviders(ctx as never);

      const result = vi.mocked(ctx.json).mock.calls[0][0] as {
        providers: Array<{
          privateKeyJwkEncrypted?: string;
          providerQuirks: Record<string, unknown>;
          hasPrivateKey: boolean;
          hasPrivateKeyJwk: boolean;
        }>;
      };
      expect(result.providers[0]?.providerQuirks.privateKeyEncrypted).toBeUndefined();
      expect(result.providers[0]?.hasPrivateKey).toBe(true);
      expect(result.providers[0]?.privateKeyJwkEncrypted).toBeUndefined();
      expect(result.providers[0]?.hasPrivateKeyJwk).toBe(true);
    });

    it('does not return FAPI2 private keys in provider responses', async () => {
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce([
        {
          id: 'fapi2-provider',
          name: 'FAPI2 OP',
          providerQuirks: {
            fapi2: {
              enabled: true,
              clientAssertionPrivateJwkEncrypted: 'encrypted-client-assertion-key',
              dpopPrivateJwkEncrypted: 'encrypted-dpop-key',
            },
          },
        },
      ] as never);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
      });
      await handleAdminListProviders(ctx as never);

      const result = vi.mocked(ctx.json).mock.calls[0][0] as {
        providers: Array<{ providerQuirks: { fapi2: Record<string, unknown> } }>;
      };
      expect(result.providers[0]?.providerQuirks.fapi2).toEqual({
        enabled: true,
        hasClientAssertionKey: true,
        hasDpopKey: true,
      });
    });

    it('should ignore tenant_id query parameter and use context tenant', async () => {
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce([]);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        query: { tenant_id: 'custom-tenant' },
        tenantId: 'context-tenant',
      });
      await handleAdminListProviders(ctx as never);

      expect(providerStore.listAllProviders).toHaveBeenCalledWith(mockEnv, 'context-tenant');
    });
  });

  describe('handleAdminCreateProvider', () => {
    it('should create a basic OIDC provider', async () => {
      const mockCreatedProvider = {
        id: 'new-provider-id',
        name: 'Test Provider',
        providerType: 'oidc',
        clientId: 'test-client-id',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce(mockCreatedProvider as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Test Provider',
          client_id: 'test-client-id',
          client_secret: 'test-secret',
          issuer: 'https://example.com',
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'new-provider-id',
          hasSecret: true,
          clientSecretEncrypted: undefined,
        }),
        201
      );
    });

    it('should reject creation without required fields', async () => {
      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Test Provider',
          // Missing client_id and client_secret
        },
      });
      const response = await handleAdminCreateProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should reject provider endpoints that target internal addresses', async () => {
      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Internal Provider',
          client_id: 'test-client-id',
          client_secret: 'test-secret',
          issuer: 'https://example.com',
          token_endpoint: 'https://169.254.169.254/token',
        },
      });

      const response = await handleAdminCreateProvider(ctx as never);

      expect(response.status).toBe(400);
      expect(providerStore.createProvider).not.toHaveBeenCalled();
    });

    it('should apply Google template defaults', async () => {
      const mockCreatedProvider = {
        id: 'google-provider-id',
        name: 'Google',
        providerType: 'oidc',
        issuer: 'https://accounts.google.com',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce(mockCreatedProvider as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Google',
          client_id: 'google-client-id',
          client_secret: 'google-secret',
          template: 'google',
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          issuer: 'https://accounts.google.com',
          scopes: 'openid email profile',
        })
      );
    });

    it('should keep Facebook template email auto-linking disabled by default', async () => {
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce({
        id: 'facebook-provider-id',
        name: 'Facebook',
        providerType: 'oauth2',
        clientSecretEncrypted: 'encrypted',
      } as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Facebook',
          client_id: 'facebook-client-id',
          client_secret: 'facebook-secret',
          template: 'facebook',
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          autoLinkEmail: false,
        })
      );
    });

    it('should preserve an explicit Facebook email auto-linking opt-in', async () => {
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce({
        id: 'facebook-provider-id',
        name: 'Facebook',
        providerType: 'oauth2',
        clientSecretEncrypted: 'encrypted',
      } as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Facebook',
          client_id: 'facebook-client-id',
          client_secret: 'facebook-secret',
          template: 'facebook',
          auto_link_email: true,
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          autoLinkEmail: true,
        })
      );
    });

    it('should apply Microsoft template defaults with common tenant', async () => {
      const mockCreatedProvider = {
        id: 'microsoft-provider-id',
        name: 'Microsoft',
        providerType: 'oidc',
        issuer: 'https://login.microsoftonline.com/common/v2.0',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce(mockCreatedProvider as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Microsoft',
          client_id: 'microsoft-client-id',
          client_secret: 'microsoft-secret',
          template: 'microsoft',
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          issuer: 'https://login.microsoftonline.com/common/v2.0',
        })
      );
    });

    it('should apply Microsoft template with organizations tenant', async () => {
      const mockCreatedProvider = {
        id: 'microsoft-provider-id',
        name: 'Microsoft',
        providerType: 'oidc',
        issuer: 'https://login.microsoftonline.com/organizations/v2.0',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce(mockCreatedProvider as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Microsoft',
          client_id: 'microsoft-client-id',
          client_secret: 'microsoft-secret',
          template: 'microsoft',
          provider_quirks: { tenantType: 'organizations' },
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          issuer: 'https://login.microsoftonline.com/organizations/v2.0',
        })
      );
    });

    it('should reject Microsoft template with invalid tenantType', async () => {
      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Microsoft',
          client_id: 'microsoft-client-id',
          client_secret: 'microsoft-secret',
          template: 'microsoft',
          provider_quirks: { tenantType: 'invalid-tenant' },
        },
      });
      const response = await handleAdminCreateProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should encrypt client secret before storing', async () => {
      const mockCreatedProvider = {
        id: 'provider-id',
        name: 'Test',
        clientSecretEncrypted: 'encrypted-secret',
      };
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce(mockCreatedProvider as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Test',
          client_id: 'client-id',
          client_secret: 'plain-secret',
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(cryptoUtils.encrypt).toHaveBeenCalledWith('plain-secret', 'mock-encryption-key');
      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          clientSecretEncrypted: 'encrypted-secret',
        })
      );
    });

    it('encrypts an Apple private key before storing provider quirks', async () => {
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce({
        id: 'apple-provider',
        name: 'Apple',
        clientSecretEncrypted: 'encrypted-secret',
        providerQuirks: {
          teamId: 'TEAMID1234',
          keyId: 'KEYID12345',
          privateKeyEncrypted: 'encrypted-secret',
        },
      } as never);
      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'Apple',
          client_id: 'com.example.service',
          client_secret: 'unused-but-required',
          template: 'apple',
          provider_quirks: {
            teamId: 'TEAMID1234',
            keyId: 'KEYID12345',
            privateKeyEncrypted: '-----BEGIN PRIVATE KEY-----raw-----END PRIVATE KEY-----',
          },
        },
      });

      await handleAdminCreateProvider(ctx as never);

      expect(cryptoUtils.encrypt).toHaveBeenCalledWith(
        '-----BEGIN PRIVATE KEY-----raw-----END PRIVATE KEY-----',
        'mock-encryption-key'
      );
      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          providerQuirks: expect.objectContaining({ privateKeyEncrypted: 'encrypted-secret' }),
        })
      );
      const response = vi.mocked(ctx.json).mock.calls.at(-1)?.[0] as {
        providerQuirks: Record<string, unknown>;
        hasPrivateKey: boolean;
      };
      expect(response.providerQuirks.privateKeyEncrypted).toBeUndefined();
      expect(response.hasPrivateKey).toBe(true);
    });

    it('encrypts separate FAPI2 client assertion and DPoP keys before storage', async () => {
      const clientAssertionJwk = {
        kty: 'EC',
        crv: 'P-256',
        kid: 'client-assertion',
        x: 'client-x',
        y: 'client-y',
        d: 'client-d',
      };
      const dpopJwk = {
        kty: 'EC',
        crv: 'P-256',
        kid: 'dpop',
        x: 'dpop-x',
        y: 'dpop-y',
        d: 'dpop-d',
      };
      vi.mocked(cryptoUtils.encrypt)
        .mockResolvedValueOnce('encrypted-client-secret')
        .mockResolvedValueOnce('encrypted-client-assertion-key')
        .mockResolvedValueOnce('encrypted-dpop-key');
      vi.mocked(providerStore.createProvider).mockResolvedValueOnce({
        id: 'fapi2-provider',
        name: 'FAPI2 OP',
        providerQuirks: {
          fapi2: {
            enabled: true,
            clientAssertionPrivateJwkEncrypted: 'encrypted-client-assertion-key',
            dpopPrivateJwkEncrypted: 'encrypted-dpop-key',
          },
        },
      } as never);

      const ctx = createMockContext('POST', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        body: {
          name: 'FAPI2 OP',
          client_id: 'fapi2-client',
          client_secret: 'unused-but-required',
          issuer: 'https://fapi.example.com',
          provider_quirks: {
            fapi2: {
              enabled: true,
              clientAssertionPrivateJwk: clientAssertionJwk,
              dpopPrivateJwk: dpopJwk,
            },
          },
        },
      });
      await handleAdminCreateProvider(ctx as never);

      expect(cryptoUtils.encrypt).toHaveBeenNthCalledWith(
        2,
        JSON.stringify(clientAssertionJwk),
        'mock-encryption-key'
      );
      expect(cryptoUtils.encrypt).toHaveBeenNthCalledWith(
        3,
        JSON.stringify(dpopJwk),
        'mock-encryption-key'
      );
      expect(providerStore.createProvider).toHaveBeenCalledWith(
        mockEnv,
        expect.objectContaining({
          providerQuirks: {
            fapi2: {
              enabled: true,
              clientAssertionPrivateJwkEncrypted: 'encrypted-client-assertion-key',
              dpopPrivateJwkEncrypted: 'encrypted-dpop-key',
            },
          },
        })
      );
      const response = vi.mocked(ctx.json).mock.calls.at(-1)?.[0] as {
        providerQuirks: { fapi2: Record<string, unknown> };
      };
      expect(response.providerQuirks.fapi2).toEqual({
        enabled: true,
        hasClientAssertionKey: true,
        hasDpopKey: true,
      });
    });
  });

  describe('handleAdminGetProvider', () => {
    it('should get provider by ID', async () => {
      const mockProvider = {
        id: 'provider-123',
        name: 'Google',
        providerType: 'oidc',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.getProvider).mockResolvedValueOnce(mockProvider as never);

      const ctx = createMockContext('GET', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
      });
      await handleAdminGetProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'provider-123',
          hasSecret: true,
          clientSecretEncrypted: undefined,
        })
      );
    });

    it('should return 404 for non-existent provider', async () => {
      vi.mocked(providerStore.getProvider).mockResolvedValueOnce(null);

      const ctx = createMockContext('GET', '/external-idp/admin/providers/unknown-id', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'unknown-id' },
      });
      const response = await handleAdminGetProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });
  });

  describe('handleAdminUpdateProvider', () => {
    it('should update provider name', async () => {
      const mockUpdatedProvider = {
        id: 'provider-123',
        name: 'Updated Name',
        providerType: 'oidc',
        clientSecretEncrypted: 'encrypted',
      };
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce(mockUpdatedProvider as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: { name: 'Updated Name' },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(providerStore.updateProvider).toHaveBeenCalledWith(
        mockEnv,
        'default',
        'provider-123',
        {
          name: 'Updated Name',
        }
      );
    });

    it('should encrypt new client secret on update', async () => {
      const mockUpdatedProvider = {
        id: 'provider-123',
        name: 'Test',
        clientSecretEncrypted: 'new-encrypted-secret',
      };
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce(mockUpdatedProvider as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: { client_secret: 'new-plain-secret' },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(cryptoUtils.encrypt).toHaveBeenCalledWith('new-plain-secret', 'mock-encryption-key');
    });

    it('preserves a stored Apple private key when updating non-secret quirks', async () => {
      vi.mocked(providerStore.getProvider).mockResolvedValueOnce({
        id: 'provider-123',
        providerQuirks: {
          teamId: 'OLDTEAM123',
          privateKeyEncrypted: 'already-encrypted-private-key',
        },
      } as never);
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce({
        id: 'provider-123',
        providerQuirks: {
          teamId: 'NEWTEAM123',
          privateKeyEncrypted: 'already-encrypted-private-key',
        },
      } as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: { provider_quirks: { teamId: 'NEWTEAM123' } },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(providerStore.updateProvider).toHaveBeenCalledWith(
        mockEnv,
        'default',
        'provider-123',
        {
          providerQuirks: {
            teamId: 'NEWTEAM123',
            privateKeyEncrypted: 'already-encrypted-private-key',
          },
        }
      );
      expect(cryptoUtils.encrypt).not.toHaveBeenCalled();
    });

    it('preserves a stored dynamic registration initial access token on sanitized UI updates', async () => {
      vi.mocked(providerStore.getProvider).mockResolvedValueOnce({
        id: 'provider-123',
        providerQuirks: {
          dynamicClientRegistration: {
            enabled: true,
            initialAccessTokenEncrypted: 'stored-encrypted-token',
          },
        },
      } as never);
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce({
        id: 'provider-123',
      } as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: {
            dynamicClientRegistration: {
              enabled: true,
              clientName: 'Updated client',
              hasInitialAccessToken: true,
            },
          },
        },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(providerStore.updateProvider).toHaveBeenCalledWith(
        mockEnv,
        'default',
        'provider-123',
        {
          providerQuirks: {
            dynamicClientRegistration: {
              enabled: true,
              clientName: 'Updated client',
              initialAccessTokenEncrypted: 'stored-encrypted-token',
            },
          },
        }
      );
    });

    it('rejects caller-supplied encrypted dynamic registration tokens', async () => {
      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: {
            dynamicClientRegistration: {
              enabled: true,
              initialAccessTokenEncrypted: 'attacker-controlled-value',
            },
          },
        },
      });

      const response = await handleAdminUpdateProvider(ctx as never);

      expect(response.status).toBe(400);
      expect(providerStore.getProvider).not.toHaveBeenCalled();
      expect(providerStore.updateProvider).not.toHaveBeenCalled();
    });

    it('preserves stored FAPI2 keys on sanitized UI updates', async () => {
      vi.mocked(providerStore.getProvider).mockResolvedValueOnce({
        id: 'provider-123',
        providerQuirks: {
          fapi2: {
            enabled: true,
            clientAssertionPrivateJwkEncrypted: 'stored-client-assertion-key',
            dpopPrivateJwkEncrypted: 'stored-dpop-key',
          },
        },
      } as never);
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce({
        id: 'provider-123',
      } as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: {
            fapi2: {
              enabled: true,
              hasClientAssertionKey: true,
              hasDpopKey: true,
              resourceUrl: 'https://resource.example.com/accounts',
            },
          },
        },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(providerStore.updateProvider).toHaveBeenCalledWith(
        mockEnv,
        'default',
        'provider-123',
        {
          providerQuirks: {
            fapi2: {
              enabled: true,
              resourceUrl: 'https://resource.example.com/accounts',
              clientAssertionPrivateJwkEncrypted: 'stored-client-assertion-key',
              dpopPrivateJwkEncrypted: 'stored-dpop-key',
            },
          },
        }
      );
      expect(cryptoUtils.encrypt).not.toHaveBeenCalled();
    });

    it('rejects caller-supplied encrypted FAPI2 key fields', async () => {
      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: {
            fapi2: {
              enabled: true,
              dpopPrivateJwkEncrypted: 'attacker-controlled-value',
            },
          },
        },
      });

      const response = await handleAdminUpdateProvider(ctx as never);

      expect(response.status).toBe(400);
      expect(providerStore.getProvider).not.toHaveBeenCalled();
      expect(providerStore.updateProvider).not.toHaveBeenCalled();
    });

    it('should reject unsafe endpoint updates', async () => {
      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: { jwks_uri: 'https://169.254.169.254/jwks.json' },
      });

      const response = await handleAdminUpdateProvider(ctx as never);

      expect(response.status).toBe(400);
      expect(providerStore.updateProvider).not.toHaveBeenCalled();
    });

    it('should validate Microsoft tenantType on update', async () => {
      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: { tenantType: 'invalid-tenant-type' },
        },
      });
      const response = await handleAdminUpdateProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });

    it('should accept valid GUID tenantType on update', async () => {
      const mockUpdatedProvider = {
        id: 'provider-123',
        providerQuirks: { tenantType: '12345678-1234-1234-1234-123456789012' },
      };
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce(mockUpdatedProvider as never);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: { tenantType: '12345678-1234-1234-1234-123456789012' },
        },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(providerStore.updateProvider).toHaveBeenCalled();
    });

    it('should return 404 for non-existent provider', async () => {
      vi.mocked(providerStore.updateProvider).mockResolvedValueOnce(null);

      const ctx = createMockContext('PUT', '/external-idp/admin/providers/unknown-id', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'unknown-id' },
        body: { name: 'New Name' },
      });
      const response = await handleAdminUpdateProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });
  });

  describe('handleAdminDeleteProvider', () => {
    it('should delete provider by ID', async () => {
      vi.mocked(providerStore.deleteProvider).mockResolvedValueOnce(true);

      const ctx = createMockContext('DELETE', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
      });
      await handleAdminDeleteProvider(ctx as never);

      expect(providerStore.deleteProvider).toHaveBeenCalledWith(mockEnv, 'default', 'provider-123');
      expect(ctx.json).toHaveBeenCalledWith({ success: true });
    });

    it('should return 404 for non-existent provider', async () => {
      vi.mocked(providerStore.deleteProvider).mockResolvedValueOnce(false);

      const ctx = createMockContext('DELETE', '/external-idp/admin/providers/unknown-id', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'unknown-id' },
      });
      const response = await handleAdminDeleteProvider(ctx as never);

      // ErrorFactory returns Response directly
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('invalid_request');
    });
  });
});
