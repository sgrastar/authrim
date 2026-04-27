import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  storeState,
  getState,
  deleteState,
  storeNonce,
  getNonce,
  deleteNonce,
  getClient,
  getCachedConsent,
} from '../kv';
import type { Env } from '../../types/env';
import type { DatabaseAdapter } from '../../db';

// Mock KV namespace
class MockKVNamespace implements KVNamespace {
  private store: Map<string, { value: string; expiration?: number }> = new Map();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check if expired
    if (entry.expiration && Date.now() > entry.expiration) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiration = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;

    this.store.set(key, { value, expiration });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(): Promise<any> {
    throw new Error('Not implemented');
  }

  async getWithMetadata(): Promise<any> {
    throw new Error('Not implemented');
  }

  clear(): void {
    this.store.clear();
  }
}

describe('KV Utilities', () => {
  let env: Env;
  let authCodesKV: MockKVNamespace;
  let stateStoreKV: MockKVNamespace;
  let nonceStoreKV: MockKVNamespace;
  let clientsCacheKV: MockKVNamespace;

  beforeEach(() => {
    authCodesKV = new MockKVNamespace();
    stateStoreKV = new MockKVNamespace();
    nonceStoreKV = new MockKVNamespace();
    clientsCacheKV = new MockKVNamespace();

    env = {
      AUTH_CODES: authCodesKV as unknown as KVNamespace,
      STATE_STORE: stateStoreKV as unknown as KVNamespace,
      NONCE_STORE: nonceStoreKV as unknown as KVNamespace,
      CLIENTS_CACHE: clientsCacheKV as unknown as KVNamespace,
      DB: {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ success: true }),
        }),
      } as unknown as D1Database,
      ISSUER_URL: 'http://localhost:8787',
      ACCESS_TOKEN_EXPIRY: '3600',
      AUTH_CODE_EXPIRY: '120',
      STATE_EXPIRY: '300',
      NONCE_EXPIRY: '300',
    };
  });

  // Note: Authorization Code operations have been migrated to AuthorizationCodeStore Durable Object.
  // See src/durable-objects/__tests__/AuthorizationCodeStore.test.ts for those tests.

  describe('State Parameter Operations', () => {
    it('should store and retrieve state parameter', async () => {
      const state = 'test-state-123';
      const clientId = 'test-client';

      await storeState(env, state, clientId);
      const retrieved = await getState(env, state);

      expect(retrieved).toBe(clientId);
    });

    it('should return null for non-existent state', async () => {
      const retrieved = await getState(env, 'non-existent-state');
      expect(retrieved).toBeNull();
    });

    it('should delete state parameter', async () => {
      const state = 'test-state-delete';
      const clientId = 'test-client';

      await storeState(env, state, clientId);
      await deleteState(env, state);

      const retrieved = await getState(env, state);
      expect(retrieved).toBeNull();
    });
  });

  describe('Nonce Parameter Operations', () => {
    it('should store and retrieve nonce parameter', async () => {
      const nonce = 'test-nonce-123';
      const clientId = 'test-client';

      await storeNonce(env, nonce, clientId);
      const retrieved = await getNonce(env, nonce);

      expect(retrieved).toBe(clientId);
    });

    it('should return null for non-existent nonce', async () => {
      const retrieved = await getNonce(env, 'non-existent-nonce');
      expect(retrieved).toBeNull();
    });

    it('should delete nonce parameter', async () => {
      const nonce = 'test-nonce-delete';
      const clientId = 'test-client';

      await storeNonce(env, nonce, clientId);
      await deleteNonce(env, nonce);

      const retrieved = await getNonce(env, nonce);
      expect(retrieved).toBeNull();
    });
  });

  describe('Client Metadata Operations (D1 + CLIENTS_CACHE Read-Through)', () => {
    it('should return client from D1 when cache misses', async () => {
      const clientId = 'test-client-123';
      const dbResult = {
        client_id: clientId,
        client_secret: 'secret',
        client_name: 'Test Client',
        redirect_uris: JSON.stringify(['http://localhost:3000/callback']),
        grant_types: JSON.stringify(['authorization_code']),
        response_types: JSON.stringify(['code']),
        scope: 'openid profile',
        token_endpoint_auth_method: 'client_secret_basic',
        contacts: null,
        logo_uri: null,
        client_uri: null,
        policy_uri: null,
        tos_uri: null,
        jwks_uri: null,
        jwks: null,
        subject_type: null,
        sector_identifier_uri: null,
        id_token_signed_response_alg: null,
        userinfo_signed_response_alg: null,
        request_object_signing_alg: null,
        allow_claims_without_scope: 0,
        created_at: 1234567890,
        updated_at: 1234567890,
      };

      // Mock D1 to return the client
      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(dbResult),
      });

      const retrieved = await getClient(env, clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.client_id).toBe(clientId);
      expect(retrieved?.client_name).toBe('Test Client');
      expect(retrieved?.redirect_uris).toEqual(['http://localhost:3000/callback']);
    });

    it('should return client from cache when available', async () => {
      const clientId = 'cached-client';
      const cachedData = {
        client_id: clientId,
        client_name: 'Cached Client',
        redirect_uris: ['http://example.com/callback'],
      };

      // Pre-populate cache using tenant-prefixed key pattern
      await clientsCacheKV.put(`tenant:default:client:${clientId}`, JSON.stringify(cachedData));

      const retrieved = await getClient(env, clientId, env.DB);

      // normalizeClientMetadata adds default values for missing fields
      const expectedNormalized = {
        ...cachedData,
        grant_types: ['authorization_code'], // Default added by normalization
        response_types: ['code'], // Default added by normalization
        contacts: undefined,
        allowed_subject_token_clients: undefined,
        allowed_token_exchange_resources: undefined,
        allowed_scopes: undefined,
        post_logout_redirect_uris: undefined,
        requestable_scopes: undefined,
        allowed_redirect_origins: undefined,
      };

      expect(retrieved).toEqual(expectedNormalized);
      // D1 should not be called when cache hits
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should normalize malformed response_types from cache', async () => {
      const clientId = 'malformed-cached-client';
      const cachedData = {
        client_id: clientId,
        client_name: 'Malformed Cached Client',
        redirect_uris: ['http://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['[', '"', 'c', 'o', 'd', 'e', '"', ']'],
      };

      await clientsCacheKV.put(`tenant:default:client:${clientId}`, JSON.stringify(cachedData));

      const retrieved = await getClient(env, clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.response_types).toEqual(['code']);
    });

    it('should normalize double-encoded response_types from D1', async () => {
      const clientId = 'double-encoded-client';
      const dbResult = {
        client_id: clientId,
        client_secret: 'secret',
        client_name: 'Double Encoded Client',
        redirect_uris: JSON.stringify(['http://localhost:3000/callback']),
        grant_types: JSON.stringify(['authorization_code']),
        response_types: JSON.stringify(JSON.stringify(['code'])),
        scope: 'openid profile',
        token_endpoint_auth_method: 'client_secret_basic',
        contacts: null,
        logo_uri: null,
        client_uri: null,
        policy_uri: null,
        tos_uri: null,
        jwks_uri: null,
        jwks: null,
        subject_type: null,
        sector_identifier_uri: null,
        id_token_signed_response_alg: null,
        userinfo_signed_response_alg: null,
        request_object_signing_alg: null,
        allow_claims_without_scope: 0,
        created_at: 1234567890,
        updated_at: 1234567890,
      };

      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(dbResult),
      });

      const retrieved = await getClient(env, clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.response_types).toEqual(['code']);
    });

    it('should return null for non-existent client', async () => {
      // Mock D1 to return null
      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      });

      const retrieved = await getClient(env, 'non-existent-client', env.DB);
      expect(retrieved).toBeNull();
    });
  });

  describe('Consent Cache Read-Through', () => {
    function createMockAdapter(result: Record<string, unknown> | null): DatabaseAdapter {
      return {
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockResolvedValue(result),
        execute: vi.fn().mockResolvedValue({ rowsAffected: 1, success: true }),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn(),
      } as unknown as DatabaseAdapter;
    }

    it('should read consent through the provided adapter when env.DB is unavailable', async () => {
      const coreAdapter = createMockAdapter({
        scope: 'openid profile',
        granted_at: 1234,
        expires_at: null,
      });
      (env as unknown as { DB?: D1Database }).DB = undefined;

      const consent = await getCachedConsent(
        env,
        'user-1',
        'client-1',
        'tenant-a',
        coreAdapter
      );

      expect(consent).toEqual({
        scope: 'openid profile',
        granted_at: 1234,
        expires_at: null,
      });
      expect(coreAdapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM oauth_client_consents'),
        ['user-1', 'client-1', 'tenant-a']
      );
    });

    it('should populate CONSENT_CACHE after a miss using the provided adapter', async () => {
      const coreAdapter = createMockAdapter({
        scope: 'openid email',
        granted_at: 5678,
        expires_at: 9999,
      });
      const consentCacheKV = new MockKVNamespace();
      (env as unknown as { DB?: D1Database }).DB = undefined;
      (env as unknown as Env).CONSENT_CACHE = consentCacheKV as unknown as KVNamespace;
      (env as unknown as Record<string, string>).CONSENT_CACHE_TTL = '120';

      const consent = await getCachedConsent(
        env,
        'user-2',
        'client-2',
        'tenant-b',
        coreAdapter
      );

      expect(consent).toEqual({
        scope: 'openid email',
        granted_at: 5678,
        expires_at: 9999,
      });
      expect(await consentCacheKV.get('tenant:default:consent:tenant-b:user-2:client-2')).toBe(
        JSON.stringify(consent)
      );
    });
  });
});
