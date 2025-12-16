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

// Define Env type locally to avoid importing from @authrim/shared
// which has cloudflare:workers dependencies
interface Env {
  ADMIN_API_SECRET?: string;
  RP_TOKEN_ENCRYPTION_KEY?: string;
  DB?: D1Database;
  SETTINGS?: KVNamespace;
  [key: string]: unknown;
}

// Mock @authrim/shared to avoid cloudflare:workers dependency
vi.mock('@authrim/shared', () => ({
  timingSafeEqual: (a: string, b: string) => {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
  },
}));

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
    ADMIN_API_SECRET: 'test-admin-secret',
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
      const ctx = createMockContext('GET', '/external-idp/admin/providers');
      const response = await handleAdminListProviders(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'unauthorized' }, 401);
    });

    it('should reject requests with invalid token', async () => {
      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      const response = await handleAdminListProviders(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'unauthorized' }, 401);
    });

    it('should reject requests with non-Bearer auth', async () => {
      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Basic test-admin-secret' },
      });
      const response = await handleAdminListProviders(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'unauthorized' }, 401);
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

    it('should use tenant_id from query parameter', async () => {
      vi.mocked(providerStore.listAllProviders).mockResolvedValueOnce([]);

      const ctx = createMockContext('GET', '/external-idp/admin/providers', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        query: { tenant_id: 'custom-tenant' },
      });
      await handleAdminListProviders(ctx as never);

      expect(providerStore.listAllProviders).toHaveBeenCalledWith(mockEnv, 'custom-tenant');
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
      await handleAdminCreateProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
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
      await handleAdminCreateProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
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
      await handleAdminGetProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'not_found' }, 404);
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

      expect(providerStore.updateProvider).toHaveBeenCalledWith(mockEnv, 'provider-123', {
        name: 'Updated Name',
      });
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

    it('should validate Microsoft tenantType on update', async () => {
      const ctx = createMockContext('PUT', '/external-idp/admin/providers/provider-123', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'provider-123' },
        body: {
          provider_quirks: { tenantType: 'invalid-tenant-type' },
        },
      });
      await handleAdminUpdateProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'invalid_request' }),
        400
      );
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
      await handleAdminUpdateProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'not_found' }, 404);
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

      expect(providerStore.deleteProvider).toHaveBeenCalledWith(mockEnv, 'provider-123');
      expect(ctx.json).toHaveBeenCalledWith({ success: true });
    });

    it('should return 404 for non-existent provider', async () => {
      vi.mocked(providerStore.deleteProvider).mockResolvedValueOnce(false);

      const ctx = createMockContext('DELETE', '/external-idp/admin/providers/unknown-id', {
        headers: { Authorization: 'Bearer test-admin-secret' },
        params: { id: 'unknown-id' },
      });
      await handleAdminDeleteProvider(ctx as never);

      expect(ctx.json).toHaveBeenCalledWith({ error: 'not_found' }, 404);
    });
  });
});
