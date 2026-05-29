import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  storeState,
  getState,
  deleteState,
  storeNonce,
  getNonce,
  deleteNonce,
  getClient,
  putClient,
  getCachedUser,
  buildUserCacheKey,
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
      const tenantId = 'tenant-1';

      await storeState(env, state, clientId, tenantId);
      const retrieved = await getState(env, state, tenantId);

      expect(retrieved).toBe(clientId);
    });

    it('should return null for non-existent state', async () => {
      const retrieved = await getState(env, 'non-existent-state', 'tenant-1');
      expect(retrieved).toBeNull();
    });

    it('should delete state parameter', async () => {
      const state = 'test-state-delete';
      const clientId = 'test-client';
      const tenantId = 'tenant-1';

      await storeState(env, state, clientId, tenantId);
      await deleteState(env, state, tenantId);

      const retrieved = await getState(env, state, tenantId);
      expect(retrieved).toBeNull();
    });
  });

  describe('Nonce Parameter Operations', () => {
    it('should store and retrieve nonce parameter', async () => {
      const nonce = 'test-nonce-123';
      const clientId = 'test-client';
      const tenantId = 'tenant-1';

      await storeNonce(env, nonce, clientId, tenantId);
      const retrieved = await getNonce(env, nonce, tenantId);

      expect(retrieved).toBe(clientId);
    });

    it('should return null for non-existent nonce', async () => {
      const retrieved = await getNonce(env, 'non-existent-nonce', 'tenant-1');
      expect(retrieved).toBeNull();
    });

    it('should delete nonce parameter', async () => {
      const nonce = 'test-nonce-delete';
      const clientId = 'test-client';
      const tenantId = 'tenant-1';

      await storeNonce(env, nonce, clientId, tenantId);
      await deleteNonce(env, nonce, tenantId);

      const retrieved = await getNonce(env, nonce, tenantId);
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

      const retrieved = await getClient(env, 'default', clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.client_id).toBe(clientId);
      expect(retrieved?.client_name).toBe('Test Client');
      expect(retrieved?.redirect_uris).toEqual(['http://localhost:3000/callback']);
    });

    it('should preserve Phase 1 client policy metadata from D1', async () => {
      const clientId = 'phase1-policy-client';
      const dbResult = {
        client_id: clientId,
        client_secret_hash: null,
        client_name: 'Phase 1 Policy Client',
        application_type: 'native',
        trust_group: 'wallet-suite',
        trust_group_id: 'wallet-suite',
        browser_public_client_mode: 'cookie_fallback',
        browser_refresh_token_policy: 'dpop_bound',
        native_sso_enabled: 1,
        native_channel_allowed: 1,
        allowed_channels: JSON.stringify(['native']),
        device_secret_revoke_enabled: 1,
        device_secret_revoke_trust_groups: JSON.stringify(['wallet-suite']),
        device_secret_introspection_enabled: 0,
        device_secret_introspection_trust_groups: JSON.stringify(['wallet-suite']),
        default_resource: 'svc://wallet-api',
        redirect_uris: JSON.stringify(['http://localhost:3000/callback']),
        grant_types: JSON.stringify(['authorization_code']),
        response_types: JSON.stringify(['code']),
        scope: 'openid profile',
        token_endpoint_auth_method: 'none',
        contacts: null,
        logo_uri: null,
        client_uri: null,
        policy_uri: null,
        tos_uri: null,
        jwks_uri: null,
        jwks: null,
        subject_type: 'public',
        sector_identifier_uri: null,
        id_token_signed_response_alg: null,
        userinfo_signed_response_alg: null,
        request_object_signing_alg: null,
        allow_claims_without_scope: 0,
        token_exchange_allowed: 0,
        allowed_subject_token_clients: null,
        allowed_token_exchange_resources: null,
        delegation_mode: 'delegation',
        client_credentials_allowed: 0,
        allowed_scopes: null,
        default_scope: null,
        default_audience: null,
        initiate_login_uri: null,
        registration_access_token_hash: null,
        post_logout_redirect_uris: null,
        backchannel_logout_uri: null,
        backchannel_logout_session_required: 0,
        frontchannel_logout_uri: null,
        frontchannel_logout_session_required: 0,
        software_id: null,
        software_version: null,
        requestable_scopes: null,
        backchannel_token_delivery_mode: null,
        backchannel_client_notification_endpoint: null,
        backchannel_authentication_request_signing_alg: null,
        backchannel_user_code_parameter: 0,
        allowed_redirect_origins: null,
        require_pkce: 0,
        tenant_id: 'default',
        created_at: 1234567890,
        updated_at: 1234567890,
      };

      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(dbResult),
      });

      const retrieved = await getClient(env, 'default', clientId, env.DB);

      expect(retrieved).toMatchObject({
        client_id: clientId,
        application_type: 'native',
        trust_group: 'wallet-suite',
        trust_group_id: 'wallet-suite',
        browser_public_client_mode: 'cookie_fallback',
        browser_refresh_token_policy: 'dpop_bound',
        native_sso_enabled: true,
        native_channel_allowed: true,
        allowed_channels: ['native'],
        device_secret_revoke_enabled: true,
        device_secret_revoke_trust_groups: ['wallet-suite'],
        device_secret_introspection_enabled: false,
        device_secret_introspection_trust_groups: ['wallet-suite'],
        default_resource: 'svc://wallet-api',
      });
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

      const retrieved = await getClient(env, 'default', clientId, env.DB);

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
        allowed_channels: undefined,
      };

      expect(retrieved).toEqual(expectedNormalized);
      // D1 should not be called when cache hits
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should isolate cached client metadata by tenant', async () => {
      const clientId = 'shared-client-id';

      await clientsCacheKV.put(
        `tenant:tenant-a:client:${clientId}`,
        JSON.stringify({
          client_id: clientId,
          client_name: 'Tenant A Client',
          redirect_uris: ['http://tenant-a.example/callback'],
        })
      );
      await clientsCacheKV.put(
        `tenant:tenant-b:client:${clientId}`,
        JSON.stringify({
          client_id: clientId,
          client_name: 'Tenant B Client',
          redirect_uris: ['http://tenant-b.example/callback'],
        })
      );

      const tenantAClient = await getClient(env, 'tenant-a', clientId, env.DB);
      const tenantBClient = await getClient(env, 'tenant-b', clientId, env.DB);

      expect(tenantAClient?.client_name).toBe('Tenant A Client');
      expect(tenantBClient?.client_name).toBe('Tenant B Client');
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

      const retrieved = await getClient(env, 'default', clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.response_types).toEqual(['code']);
    });

    it('should fail runtime client config containing legacy app_suite', async () => {
      const clientId = 'legacy-app-suite-client';
      const cachedData = {
        client_id: clientId,
        client_name: 'Legacy App Suite Client',
        redirect_uris: ['http://example.com/callback'],
        app_suite: 'wallet-suite',
      };

      await clientsCacheKV.put(`tenant:default:client:${clientId}`, JSON.stringify(cachedData));

      await expect(getClient(env, 'default', clientId, env.DB)).rejects.toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        statusCode: 400,
      });
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should normalize client metadata before write-through caching', async () => {
      const clientId = 'write-through-normalized-client';

      await putClient(env, {
        client_id: clientId,
        tenant_id: 'default',
        client_name: 'Write-Through Client',
        redirect_uris: 'http://example.com/callback' as unknown as string[],
      });

      const cached = await clientsCacheKV.get(`tenant:default:client:${clientId}`);
      expect(JSON.parse(cached ?? '{}')).toMatchObject({
        client_id: clientId,
        redirect_uris: ['http://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      });
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

      const retrieved = await getClient(env, 'default', clientId, env.DB);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.response_types).toEqual(['code']);
    });

    it('should return null for non-existent client', async () => {
      // Mock D1 to return null
      (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
      });

      const retrieved = await getClient(env, 'default', 'non-existent-client', env.DB);
      expect(retrieved).toBeNull();
    });
  });

  describe('User Cache Read-Through', () => {
    function createCanonicalUserAdapters(input?: {
      userId?: string;
      email?: string;
      name?: string;
    }): { coreAdapter: DatabaseAdapter; piiAdapter: DatabaseAdapter } {
      const userId = input?.userId ?? 'user-1';
      const email = input?.email ?? 'user@example.test';
      const coreAdapter = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM profile_attribute_values')) return [];
          if (sql.includes('FROM contact_points')) {
            return [
                {
                  account_id: `account:${userId}`,
                  contact_type: 'email',
                  verification_state: 'verified',
                  value_storage_ref: `canonical-sensitive://tenant-a/${userId}/email`,
              },
            ];
          }
          return [];
        }),
        queryOne: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM identity_accounts')) {
            return {
              id: `account:${userId}`,
              tenant_id: 'tenant-a',
              account_type: 'user',
              lifecycle_state: 'active',
              legacy_user_id: userId,
              primary_subject_id: `subject:${userId}`,
              display_label: null,
              metadata_json: null,
              created_at: 123,
              updated_at: 124,
              deleted_at: null,
            };
          }
          if (sql.includes('FROM identity_subjects')) {
            return {
              id: `subject:${userId}`,
              tenant_id: 'tenant-a',
              subject_type: 'person',
              lifecycle_state: 'active',
              display_label: null,
              primary_account_id: `account:${userId}`,
              risk_tier: null,
              assurance_level: null,
              metadata_json: null,
              created_at: 123,
              updated_at: 124,
              deleted_at: null,
            };
          }
          if (sql.includes('FROM profiles')) {
            return {
              id: `profile:${userId}`,
              tenant_id: 'tenant-a',
              subject_id: `subject:${userId}`,
              profile_type: 'person',
              lifecycle_state: 'active',
              locale: null,
              zoneinfo: null,
              display_name_ref: null,
              metadata_json: null,
              created_at: 123,
              updated_at: 124,
              deleted_at: null,
            };
          }
          return null;
        }),
        execute: vi.fn().mockResolvedValue({ rowsAffected: 1, success: true }),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn(),
      } as unknown as DatabaseAdapter;
      const piiAdapter = {
        query: vi.fn().mockResolvedValue([]),
        queryOne: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes('FROM identity_sensitive_values')) {
            return { value_json: JSON.stringify(email) };
          }
          return null;
        }),
        execute: vi.fn().mockResolvedValue({ rowsAffected: 1, success: true }),
        transaction: vi.fn(),
        batch: vi.fn(),
        isHealthy: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 0, type: 'mock' }),
        getType: vi.fn().mockReturnValue('mock'),
        close: vi.fn(),
      } as unknown as DatabaseAdapter;
      return { coreAdapter, piiAdapter };
    }

    it('builds profile-aware user cache keys when storage scope is provided', () => {
      expect(
        buildUserCacheKey('tenant-a', 'user-1', {
          storageProfileId: 'builtin:storage:tenant-d1',
          sourceGeneration: 3,
          schemaVersion: 12,
        })
      ).toBe('tenant:tenant-a:user:v2:sp:builtin%3Astorage%3Atenant-d1:gen:3:schema:12:user-1');
    });

    it('should isolate cached user metadata by tenant', async () => {
      const userCacheKV = new MockKVNamespace();
      (env as unknown as Env).USER_CACHE = userCacheKV as unknown as KVNamespace;
      const userId = 'shared-user-id';

      await userCacheKV.put(
        `tenant:tenant-a:user:${userId}`,
        JSON.stringify({ id: userId, email: 'a@example.test', email_verified: true })
      );
      await userCacheKV.put(
        `tenant:tenant-b:user:${userId}`,
        JSON.stringify({ id: userId, email: 'b@example.test', email_verified: true })
      );

      const tenantAUser = await getCachedUser(env, 'tenant-a', userId, {
        coreDb: env.DB,
        piiCacheMode: 'merged',
      });
      const tenantBUser = await getCachedUser(env, 'tenant-b', userId, {
        coreDb: env.DB,
        piiCacheMode: 'merged',
      });

      expect(tenantAUser?.email).toBe('a@example.test');
      expect(tenantBUser?.email).toBe('b@example.test');
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });

    it('should ignore old user cache entries when storage profile scope changes', async () => {
      const userCacheKV = new MockKVNamespace();
      (env as unknown as Env).USER_CACHE = userCacheKV as unknown as KVNamespace;
      const userId = 'profile-scoped-user';

      await userCacheKV.put(
        buildUserCacheKey('tenant-a', userId, {
          storageProfileId: 'builtin:storage:shared-d1',
          sourceGeneration: 1,
          schemaVersion: 1,
        }),
        JSON.stringify({ id: userId, email: 'old@example.test', email_verified: true })
      );

      const { coreAdapter, piiAdapter } = createCanonicalUserAdapters({ userId });

      const user = await getCachedUser(env, 'tenant-a', userId, {
        coreDb: coreAdapter,
        piiDb: piiAdapter,
        piiCacheMode: 'merged',
        cacheScope: {
          storageProfileId: 'builtin:storage:tenant-d1',
          sourceGeneration: 2,
          schemaVersion: 1,
        },
      });

      expect(user?.email).not.toBe('old@example.test');
      expect(coreAdapter.queryOne).toHaveBeenCalled();
    });

    it('should include tenant scope in user DB fallback queries', async () => {
      const { coreAdapter, piiAdapter } = createCanonicalUserAdapters();

      await getCachedUser(env, 'tenant-a', 'user-1', {
        coreDb: coreAdapter,
        piiDb: piiAdapter,
      });

      expect(coreAdapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = ?'),
        expect.arrayContaining(['user-1', 'tenant-a'])
      );
    });

    it('encrypts short-TTL cross-request PII cache entries', async () => {
      const userCacheKV = new MockKVNamespace();
      (env as unknown as Env).USER_CACHE = userCacheKV as unknown as KVNamespace;
      env.OBJECT_ENCRYPTION_ROOT_KEY =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      env.OBJECT_ENCRYPTION_KEY_VERSION = '7';
      env.PII_CACHE_TTL = '120';
      const { coreAdapter, piiAdapter } = createCanonicalUserAdapters();

      const first = await getCachedUser(env, 'tenant-a', 'user-1', {
        coreDb: coreAdapter,
        piiDb: piiAdapter,
        piiCacheMode: 'encrypted_short_ttl',
      });
      const rawCached = await userCacheKV.get(buildUserCacheKey('tenant-a', 'user-1'));
      const second = await getCachedUser(env, 'tenant-a', 'user-1', {
        coreDb: coreAdapter,
        piiDb: piiAdapter,
        piiCacheMode: 'encrypted_short_ttl',
      });

      expect(first?.email).toBe('user@example.test');
      expect(second?.email).toBe('user@example.test');
      expect(rawCached).not.toContain('user@example.test');
      expect(JSON.parse(rawCached ?? '{}')).toMatchObject({
        purpose: 'user-pii-cache',
        algorithm: 'AES-256-GCM',
        tenantId: 'tenant-a',
        keyVersion: 7,
        keyState: 'current',
      });
      expect(coreAdapter.queryOne).toHaveBeenCalled();
      expect(piiAdapter.queryOne).toHaveBeenCalledTimes(1);
    });

    it('does not read or write cross-request PII cache when no_cross_request_pii mode is enabled', async () => {
      const userCacheKV = new MockKVNamespace();
      (env as unknown as Env).USER_CACHE = userCacheKV as unknown as KVNamespace;
      const { coreAdapter, piiAdapter } = createCanonicalUserAdapters();

      const user = await getCachedUser(env, 'tenant-a', 'user-1', {
        coreDb: coreAdapter,
        piiDb: piiAdapter,
        piiCacheMode: 'no_cross_request_pii',
      });

      expect(user?.email).toBe('user@example.test');
      expect(await userCacheKV.get(buildUserCacheKey('tenant-a', 'user-1'))).toBeNull();
      expect(coreAdapter.queryOne).toHaveBeenCalled();
      expect(piiAdapter.queryOne).toHaveBeenCalledTimes(1);
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

      const consent = await getCachedConsent(env, 'user-1', 'client-1', 'tenant-a', coreAdapter);

      expect(consent).toEqual({
        scope: 'openid profile',
        granted_at: 1234,
        expires_at: null,
      });
      expect(coreAdapter.queryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM oauth_client_consents'),
        ['tenant-a', 'user-1', 'client-1']
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

      const consent = await getCachedConsent(env, 'user-2', 'client-2', 'tenant-b', coreAdapter);

      expect(consent).toEqual({
        scope: 'openid email',
        granted_at: 5678,
        expires_at: 9999,
      });
      expect(await consentCacheKV.get('tenant:tenant-b:consent:user-2:client-2')).toBe(
        JSON.stringify(consent)
      );
    });
  });
});
