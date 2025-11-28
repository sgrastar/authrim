import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  storeState,
  getState,
  deleteState,
  storeNonce,
  getNonce,
  deleteNonce,
  getClient,
} from '../kv';
import type { Env } from '../../types/env';

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
      TOKEN_EXPIRY: '3600',
      CODE_EXPIRY: '120',
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

      const retrieved = await getClient(env, clientId);

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
      await clientsCacheKV.put(
        `tenant:default:client:${clientId}`,
        JSON.stringify(cachedData)
      );

      const retrieved = await getClient(env, clientId);

      expect(retrieved).toEqual(cachedData);
      // D1 should not be called when cache hits
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should return null for non-existent client', async () => {
      // Mock D1 to return null
      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      });

      const retrieved = await getClient(env, 'non-existent-client');
      expect(retrieved).toBeNull();
    });
  });
});
