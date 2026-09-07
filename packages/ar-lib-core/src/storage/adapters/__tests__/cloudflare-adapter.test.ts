/**
 * CloudflareStorageAdapter Unit Tests
 *
 * Tests for the unified storage adapter and its routing logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CloudflareStorageAdapter,
  UserStore,
  ClientStore,
  SessionStore,
  PasskeyStore,
  createStorageAdapter,
} from '../cloudflare-adapter';
import type { Env } from '../../../types/env';
import * as sessionHelper from '../../../utils/session-helper';

// Helper to create mock DO stubs with RPC methods
function createMockSessionStoreDO() {
  return {
    getSessionRpc: vi.fn().mockResolvedValue({ id: 'session_123' }),
    createSessionRpc: vi
      .fn()
      .mockResolvedValue({ id: 'session_123', expiresAt: Date.now() + 86400000 }),
    invalidateSessionRpc: vi.fn().mockResolvedValue(true),
    listSessionsRpc: vi.fn().mockResolvedValue({ sessions: [] }),
    extendSessionRpc: vi.fn().mockResolvedValue({ id: 'session_123' }),
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'session_123' }), { status: 200 })),
  };
}

function createMockAuthCodeStoreDO() {
  return {
    hasCodeRpc: vi.fn().mockResolvedValue(true),
    storeCodeRpc: vi.fn().mockResolvedValue({ success: true, expiresAt: Date.now() + 60000 }),
    consumeCodeRpc: vi.fn().mockResolvedValue({ valid: true }),
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ exists: true }), { status: 200 })),
  };
}

function createMockRefreshTokenRotatorDO() {
  return {
    getFamilyRpc: vi.fn().mockResolvedValue({ id: 'family_123' }),
    createFamilyRpc: vi.fn().mockResolvedValue({ familyId: 'family_123' }),
    rotateRpc: vi.fn().mockResolvedValue({ newRefreshToken: 'new_token' }),
    revokeFamilyRpc: vi.fn().mockResolvedValue(undefined),
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'family_123' }), { status: 200 })),
  };
}

function createMockGenericDO() {
  return {
    fetch: vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
  };
}

// Mock environment
function createMockEnv(): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    } as unknown as D1Database,
    // DB_PII for PII/Non-PII DB separation
    DB_PII: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      }),
    } as unknown as D1Database,
    CLIENTS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    CLIENTS_CACHE: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as KVNamespace,
    SESSION_STORE: {
      idFromName: vi.fn().mockReturnValue('session-do-id'),
      get: vi.fn().mockReturnValue(createMockSessionStoreDO()),
    } as unknown as DurableObjectNamespace,
    AUTH_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('authcode-do-id'),
      get: vi.fn().mockReturnValue(createMockAuthCodeStoreDO()),
    } as unknown as DurableObjectNamespace,
    REFRESH_TOKEN_ROTATOR: {
      idFromName: vi.fn().mockReturnValue('refreshtoken-do-id'),
      get: vi.fn().mockReturnValue(createMockRefreshTokenRotatorDO()),
    } as unknown as DurableObjectNamespace,
    CHALLENGE_STORE: {
      idFromName: vi.fn().mockReturnValue('challenge-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER: {} as unknown as DurableObjectNamespace,
    RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('rate-limiter-do-id'),
      get: vi.fn().mockReturnValue({
        incrementRpc: vi.fn().mockResolvedValue({ allowed: true, current: 1, limit: 100 }),
        fetch: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ allowed: true, current: 1, limit: 100 }), { status: 200 })
          ),
      }),
    } as unknown as DurableObjectNamespace,
    USER_CODE_RATE_LIMITER: {
      idFromName: vi.fn().mockReturnValue('user-code-rate-limiter-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    PAR_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('par-request-do-id'),
      get: vi.fn().mockReturnValue({
        storeRequestRpc: vi.fn().mockResolvedValue(undefined),
        consumeRequestRpc: vi.fn().mockResolvedValue({ client_id: 'test' }),
        fetch: vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 201 })),
      }),
    } as unknown as DurableObjectNamespace,
    DPOP_JTI_STORE: {
      idFromName: vi.fn().mockReturnValue('dpop-jti-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    DEVICE_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('device-code-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    TOKEN_REVOCATION_STORE: {
      idFromName: vi.fn().mockReturnValue('token-revocation-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    CIBA_REQUEST_STORE: {
      idFromName: vi.fn().mockReturnValue('ciba-request-do-id'),
      get: vi.fn().mockReturnValue(createMockGenericDO()),
    } as unknown as DurableObjectNamespace,
    STATE_STORE: {} as KVNamespace,
    NONCE_STORE: {} as KVNamespace,
    PUBLIC_ASSETS: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as R2Bucket,
    ISSUER_URL: 'https://idp.example.com',
    ACCESS_TOKEN_EXPIRY: '3600',
    AUTH_CODE_EXPIRY: '600',
    STATE_EXPIRY: '600',
    NONCE_EXPIRY: '600',
    REFRESH_TOKEN_EXPIRY: '2592000',
  };
}

describe('CloudflareStorageAdapter', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env, 'default');
  });

  it('rejects missing tenant id at construction time', () => {
    expect(() => new CloudflareStorageAdapter(env, '')).toThrow(
      'CloudflareStorageAdapter requires tenantId'
    );
  });

  describe('Routing Logic', () => {
    it('should route session: prefix to SessionStore DO', async () => {
      await adapter.get('session:123');
      expect(env.SESSION_STORE.get).toHaveBeenCalled();
    });

    it('should route legacy session DO by configured tenant', async () => {
      adapter = new CloudflareStorageAdapter(env, 'acme');

      await adapter.get('session:123');

      expect(env.SESSION_STORE.idFromName).toHaveBeenCalledWith('tenant:acme:session');
    });

    it('should read client security metadata directly from D1', async () => {
      (env.CLIENTS_CACHE?.get as any).mockResolvedValue(
        JSON.stringify({ client_id: 'stale-client' })
      );
      // Mock D1 to return data
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ data: JSON.stringify({ client_id: 'test-client' }) }),
      });

      const result = await adapter.get('client:test-client');
      expect(result).toBe(JSON.stringify({ client_id: 'test-client' }));
      expect(env.CLIENTS_CACHE?.get).not.toHaveBeenCalled();
      expect(env.DB.prepare).toHaveBeenCalled();
    });

    it('should route user: prefix to D1', async () => {
      await adapter.get('user:123');
      expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'));
    });

    it('should route authcode: prefix to AuthCodeStore DO', async () => {
      await adapter.get('authcode:abc123');
      expect(env.AUTH_CODE_STORE.get).toHaveBeenCalled();
    });

    it('should route authcode DO by configured tenant', async () => {
      adapter = new CloudflareStorageAdapter(env, 'acme');

      await adapter.get('authcode:abc123');

      expect(env.AUTH_CODE_STORE.idFromName).toHaveBeenCalledWith('tenant:acme:auth-code');
    });

    it('should reject low-level refreshtoken reads without routing metadata', async () => {
      await expect(adapter.get('refreshtoken:family_123')).rejects.toThrow(
        'Use getRefreshToken() from @authrim/ar-lib-core/utils/refresh-token-store instead.'
      );
    });

    it('should throw error for unknown prefixes (KV fallback is deprecated)', async () => {
      await expect(adapter.get('unknown:key')).rejects.toThrow(
        'getFromKV called with unknown:key - CLIENTS KV is deprecated'
      );
    });
  });

  describe('Set Operations', () => {
    it('should set value with session: prefix to SessionStore DO', async () => {
      const mockCreateSessionRpc = vi.fn().mockResolvedValue({
        id: '123',
        userId: 'user_123',
        expiresAt: Date.now() + 86400000,
      });
      (env.SESSION_STORE.get as any).mockReturnValue({ createSessionRpc: mockCreateSessionRpc });

      await adapter.set('session:123', JSON.stringify({ user_id: 'user_123', data: {} }));
      expect(mockCreateSessionRpc).toHaveBeenCalled();
    });

    it('should set value with client: prefix to D1 and invalidate KV cache', async () => {
      await adapter.set('client:test-client', JSON.stringify({ client_id: 'test-client' }));
      expect(env.DB.prepare).toHaveBeenCalled();
      expect(env.CLIENTS_CACHE?.delete).toHaveBeenCalled();
    });

    it('should attach configured tenant to legacy authcode writes', async () => {
      adapter = new CloudflareStorageAdapter(env, 'acme');
      const authCodeStub = createMockAuthCodeStoreDO();
      (env.AUTH_CODE_STORE.get as any).mockReturnValue(authCodeStub);

      await adapter.set(
        'authcode:abc123',
        JSON.stringify({
          code: 'abc123',
          clientId: 'client-1',
          redirectUri: 'https://client.example/cb',
          userId: 'user-1',
          scope: 'openid',
        })
      );

      expect(authCodeStub.storeCodeRpc).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'abc123', tenantId: 'acme' })
      );
    });

    it('should set value with refreshtoken: prefix via sharded refresh token helper', async () => {
      const mockCreateFamilyRpc = vi.fn().mockResolvedValue({ familyId: 'family_123' });
      (env.REFRESH_TOKEN_ROTATOR.get as any).mockReturnValue({
        createFamilyRpc: mockCreateFamilyRpc,
      });

      await adapter.set(
        'refreshtoken:g1:wnam:7:rt_123',
        JSON.stringify({
          jti: 'g1:wnam:7:rt_123',
          client_id: 'client_123',
          sub: 'user_123',
          scope: 'openid offline_access',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      );

      expect(env.REFRESH_TOKEN_ROTATOR.get).toHaveBeenCalled();
      expect(mockCreateFamilyRpc).toHaveBeenCalled();
    });

    it('should throw error for unknown prefixes (KV fallback is deprecated)', async () => {
      await expect(adapter.set('custom:key', 'value', 3600)).rejects.toThrow(
        'setToKV called with custom:key - CLIENTS KV is deprecated'
      );
    });
  });

  describe('Delete Operations', () => {
    it('should delete session from SessionStore DO', async () => {
      const mockInvalidateSessionRpc = vi.fn().mockResolvedValue(true);
      (env.SESSION_STORE.get as any).mockReturnValue({
        invalidateSessionRpc: mockInvalidateSessionRpc,
      });

      await adapter.delete('session:123');
      expect(mockInvalidateSessionRpc).toHaveBeenCalledWith('123');
    });

    it('should delete client from D1 and invalidate KV cache', async () => {
      await adapter.delete('client:test-client');
      expect(env.DB.prepare).toHaveBeenCalled();
      expect(env.CLIENTS_CACHE?.delete).toHaveBeenCalled();
    });

    it('should reject low-level refreshtoken deletes without routing metadata', async () => {
      await expect(adapter.delete('refreshtoken:family_123')).rejects.toThrow(
        'Use deleteRefreshToken() from @authrim/ar-lib-core/utils/refresh-token-store instead.'
      );
    });

    it('should throw error for unknown prefixes (KV fallback is deprecated)', async () => {
      await expect(adapter.delete('custom:key')).rejects.toThrow(
        'deleteFromKV called with custom:key - CLIENTS KV is deprecated'
      );
    });
  });

  describe('SQL Operations', () => {
    it('should execute query and return results', async () => {
      const mockResults = [{ id: '1', name: 'Test' }];
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: mockResults }),
      });

      const results = await adapter.query('SELECT * FROM users WHERE id = ?', ['1']);
      expect(results).toEqual(mockResults);
      expect(env.DB.prepare).toHaveBeenCalledWith('SELECT * FROM users WHERE id = ?');
    });

    it('should execute statement without returning results', async () => {
      await adapter.execute('DELETE FROM users WHERE id = ?', ['1']);
      expect(env.DB.prepare).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?');
    });
  });
});

describe('UserStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let userStore: UserStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env, 'default');
    userStore = new UserStore(adapter);
  });

  function mockCanonicalRuntimeUser(userId = 'user_123', email = 'test@example.com') {
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => ({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({
        results: sql.includes('FROM contact_points')
          ? [
              {
                account_id: `account:${userId}`,
                contact_type: 'email',
                verification_state: 'verified',
                value_storage_ref: `canonical-sensitive://default/${userId}/email`,
              },
            ]
          : sql.includes('FROM profile_attribute_values')
            ? []
            : [],
      }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
    }));
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: unknown[]) => ({
        all: vi.fn().mockResolvedValue({
          results: sql.includes('FROM contact_points')
            ? [
                {
                  account_id: `account:${userId}`,
                  contact_type: 'email',
                  verification_state: 'verified',
                  value_storage_ref: `canonical-sensitive://default/${userId}/email`,
                },
              ]
            : [],
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(null),
        then: undefined,
        get results() {
          return params;
        },
      })),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
    }));
    const corePrepare = env.DB.prepare as ReturnType<typeof vi.fn>;
    corePrepare.mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((..._params: unknown[]) => ({
        all: vi.fn().mockResolvedValue({
          results: sql.includes('FROM identity_accounts')
            ? [
                {
                  id: `account:${userId}`,
                  tenant_id: 'default',
                  account_type: 'user',
                  lifecycle_state: 'active',
                  legacy_user_id: userId,
                  primary_subject_id: `subject:${userId}`,
                  display_label: null,
                  metadata_json: null,
                  created_at: 1234567890,
                  updated_at: 1234567891,
                  deleted_at: null,
                },
              ]
            : sql.includes('FROM identity_subjects')
              ? [
                  {
                    id: `subject:${userId}`,
                    tenant_id: 'default',
                    subject_type: 'person',
                    lifecycle_state: 'active',
                    display_label: null,
                    primary_account_id: `account:${userId}`,
                    risk_tier: null,
                    assurance_level: null,
                    metadata_json: null,
                    created_at: 1234567890,
                    updated_at: 1234567891,
                    deleted_at: null,
                  },
                ]
              : sql.includes('FROM profiles')
                ? [
                    {
                      id: `profile:${userId}`,
                      tenant_id: 'default',
                      subject_id: `subject:${userId}`,
                      profile_type: 'person',
                      lifecycle_state: 'active',
                      locale: null,
                      zoneinfo: null,
                      display_name_ref: null,
                      metadata_json: null,
                      created_at: 1234567890,
                      updated_at: 1234567891,
                      deleted_at: null,
                    },
                  ]
                : sql.includes('FROM contact_points')
                  ? [
                      {
                        account_id: `account:${userId}`,
                        contact_type: 'email',
                        verification_state: 'verified',
                        value_storage_ref: `canonical-sensitive://default/${userId}/email`,
                      },
                    ]
                  : [],
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(null),
      })),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
    }));
    (env.DB_PII.prepare as ReturnType<typeof vi.fn>).mockImplementation((sql: string) => ({
      bind: vi.fn().mockImplementation((...params: unknown[]) => ({
        all: vi.fn().mockResolvedValue({
          results: sql.includes('FROM identity_sensitive_values')
            ? [{ owner_id: userId, value_json: JSON.stringify(email) }]
            : [],
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
        first: vi.fn().mockResolvedValue(null),
      })),
      all: vi.fn().mockResolvedValue({ results: [] }),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue(null),
    }));
  }

  it('should get user by ID', async () => {
    mockCanonicalRuntimeUser();
    const user = await userStore.get('user_123');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('user_123');
    expect(user!.email).toBe('test@example.com');
    expect(user!.email_verified).toBe(true);
    expect(user!.created_at).toBe(1234567890000);
  });

  it('should get user by email', async () => {
    mockCanonicalRuntimeUser();
    const user = await userStore.getByEmail('test@example.com');
    expect(user).not.toBeNull();
    expect(user!.id).toBe('user_123');
    expect(user!.email).toBe('test@example.com');
    expect(user!.created_at).toBe(1234567890000);
  });

  it('should create new user', async () => {
    mockCanonicalRuntimeUser();
    const newUser = { email: 'new@example.com', name: 'New User' };
    const user = await userStore.create(newUser);

    expect(user.id).toBeDefined();
    expect(user.created_at).toBeDefined();
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('identity_accounts'));
    expect(env.DB_PII.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO identity_sensitive_values')
    );
  });

  it('should update existing user', async () => {
    mockCanonicalRuntimeUser();
    const updated = await userStore.update('user_123', { name: 'Updated Name' });
    expect(updated.id).toBe('user_123');
    expect(env.DB_PII.prepare).toHaveBeenCalledWith(
      expect.stringContaining('identity_sensitive_values')
    );
  });

  it('should delete user (soft delete)', async () => {
    mockCanonicalRuntimeUser();
    await userStore.delete('user_123');
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE identity_accounts')
    );
  });

  it('should throw error when updating non-existent user', async () => {
    (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    });
    (env.DB_PII.prepare as ReturnType<typeof vi.fn>).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    });

    await expect(userStore.update('non_existent', { name: 'Test' })).rejects.toThrow(
      'User not found'
    );
  });
});

describe('ClientStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let clientStore: ClientStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env, 'default');
    clientStore = new ClientStore(adapter);
  });

  it('should get client by ID', async () => {
    const mockClient = {
      client_id: 'client_123',
      client_name: 'Test Client',
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      created_at: 1234567890,
      updated_at: 1234567890,
    };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockClient] }),
    });

    const client = await clientStore.get('client_123');
    expect(client).toEqual(mockClient);
  });

  it('should create new client', async () => {
    const newClient = {
      client_id: 'client_new',
      client_name: 'New Client',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
    };

    const client = await clientStore.create(newClient);
    expect(client.client_id).toBe('client_new');
    expect(client.created_at).toBeDefined();
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO oauth_clients')
    );
  });

  it('should update existing client', async () => {
    const mockClient = {
      client_id: 'client_123',
      client_name: 'Test Client',
      redirect_uris: [],
      grant_types: [],
      response_types: [],
      created_at: 1234567890,
      updated_at: 1234567890,
    };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockClient] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    });

    const updated = await clientStore.update('client_123', { client_name: 'Updated Client' });
    expect(updated.client_name).toBe('Updated Client');
  });

  it('should delete client', async () => {
    await clientStore.delete('client_123');
    expect(env.DB.prepare).toHaveBeenCalledWith(
      'DELETE FROM oauth_clients WHERE tenant_id = ? AND client_id = ?'
    );
  });

  it('should list clients with pagination', async () => {
    const mockClients = [
      {
        client_id: 'client_1',
        created_at: 1234567890,
        updated_at: 1234567890,
        redirect_uris: [],
        grant_types: [],
        response_types: [],
      },
      {
        client_id: 'client_2',
        created_at: 1234567891,
        updated_at: 1234567891,
        redirect_uris: [],
        grant_types: [],
        response_types: [],
      },
    ];
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockClients }),
    });

    const clients = await clientStore.list({ limit: 10, offset: 0 });
    expect(clients).toHaveLength(2);
  });
});

describe('SessionStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let sessionStore: SessionStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env, 'default');
    sessionStore = new SessionStore(adapter, env);
  });

  it('should get session by ID', async () => {
    const mockSession = {
      id: 'g1:wnam:7:session_123',
      user_id: 'user_123',
      created_at: 1234567890,
      expires_at: 1234567890 + 86400,
    };
    const mockGetSessionRpc = vi.fn().mockResolvedValue(mockSession);
    (env.SESSION_STORE.get as any).mockReturnValue({ getSessionRpc: mockGetSessionRpc });

    const session = await sessionStore.get('g1:wnam:7:session_123');
    expect(session).toEqual(mockSession);
    expect(mockGetSessionRpc).toHaveBeenCalledWith('g1:wnam:7:session_123');
    expect(env.SESSION_STORE.idFromName).toHaveBeenCalledWith('default:wnam:ses:7');
  });

  it('should return null for non-existent session', async () => {
    const mockGetSessionRpc = vi.fn().mockResolvedValue(null);
    (env.SESSION_STORE.get as any).mockReturnValue({ getSessionRpc: mockGetSessionRpc });

    const session = await sessionStore.get('non_existent');
    expect(session).toBeNull();
  });

  it('should create new session', async () => {
    const mockCreateSessionRpc = vi
      .fn()
      .mockImplementation(
        async (sessionId: string, userId: string, ttl: number, data: unknown) => ({
          id: sessionId,
          userId,
          expiresAt: Date.now() + ttl * 1000,
          data,
        })
      );
    const getSessionStoreForNewSessionSpy = vi
      .spyOn(sessionHelper, 'getSessionStoreForNewSession')
      .mockResolvedValue({
        stub: {
          createSessionRpc: mockCreateSessionRpc,
        } as any,
        sessionId: 'g1:wnam:7:session_test',
        resolution: {
          generation: 1,
          regionKey: 'wnam',
          shardIndex: 7,
        },
        instanceName: 'default:wnam:ses:7',
      });

    const session = await sessionStore.create({ user_id: 'user_123', data: { amr: ['pwd'] } });
    expect(session.id).toBe('g1:wnam:7:session_test');
    expect(mockCreateSessionRpc).toHaveBeenCalledWith(
      'g1:wnam:7:session_test',
      'user_123',
      expect.any(Number), // ttl
      { amr: ['pwd'] },
      'default'
    );
    getSessionStoreForNewSessionSpy.mockRestore();
  });

  it('should delete session', async () => {
    const mockInvalidateSessionRpc = vi.fn().mockResolvedValue(true);
    (env.SESSION_STORE.get as any).mockReturnValue({
      invalidateSessionRpc: mockInvalidateSessionRpc,
    });

    await sessionStore.delete('session_123');
    expect(mockInvalidateSessionRpc).toHaveBeenCalledWith('session_123');
  });

  it('should reject listByUser without a user-session index', async () => {
    await expect(sessionStore.listByUser('user_123')).rejects.toThrow(
      'is not supported for region-sharded sessions without a user-session index'
    );
  });

  it('should extend session expiration', async () => {
    const mockSession = {
      id: 'session_123',
      user_id: 'user_123',
      created_at: 1234567890,
      expires_at: 1234567890 + 86400 + 3600,
    };
    const mockExtendSessionRpc = vi.fn().mockResolvedValue(mockSession);
    (env.SESSION_STORE.get as any).mockReturnValue({ extendSessionRpc: mockExtendSessionRpc });

    const extended = await sessionStore.extend('session_123', 3600);
    expect(extended).toBeDefined();
    expect(mockExtendSessionRpc).toHaveBeenCalledWith('session_123', 3600);
  });
});

describe('PasskeyStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let passkeyStore: PasskeyStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env, 'default');
    passkeyStore = new PasskeyStore(adapter);
  });

  it('should get passkey by credential ID', async () => {
    const mockPasskey = {
      id: 'passkey_123',
      user_id: 'user_123',
      credential_id: 'cred_123',
      public_key: 'pubkey',
      counter: 0,
      created_at: 1234567890,
    };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockPasskey] }),
    });

    const passkey = await passkeyStore.getByCredentialId('cred_123');
    expect(passkey).toEqual(mockPasskey);
  });

  it('should list passkeys by user', async () => {
    const mockPasskeys = [
      {
        id: 'passkey_1',
        user_id: 'user_123',
        credential_id: 'cred_1',
        public_key: 'pubkey1',
        counter: 0,
        created_at: 1234567890,
      },
      {
        id: 'passkey_2',
        user_id: 'user_123',
        credential_id: 'cred_2',
        public_key: 'pubkey2',
        counter: 0,
        created_at: 1234567891,
      },
    ];
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: mockPasskeys }),
    });

    const passkeys = await passkeyStore.listByUser('user_123');
    expect(passkeys).toHaveLength(2);
  });

  it('should create new passkey', async () => {
    const newPasskey = {
      user_id: 'user_123',
      credential_id: 'cred_new',
      public_key: 'pubkey_new',
      counter: 0,
    };

    const passkey = await passkeyStore.create(newPasskey);
    expect(passkey.id).toBeDefined();
    expect(passkey.credential_id).toBe('cred_new');
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO passkeys'));
  });

  it('should update passkey counter', async () => {
    const mockPasskey = {
      id: 'passkey_123',
      user_id: 'user_123',
      credential_id: 'cred_123',
      public_key: 'pubkey',
      counter: 5,
      created_at: 1234567890,
      last_used_at: Math.floor(Date.now() / 1000),
    };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      all: vi.fn().mockResolvedValue({ results: [mockPasskey] }),
    });

    const updated = await passkeyStore.updateCounter('passkey_123', 6);
    expect(updated.counter).toBe(6);
  });

  it('should delete passkey', async () => {
    await passkeyStore.delete('passkey_123');
    expect(env.DB.prepare).toHaveBeenCalledWith(
      'DELETE FROM passkeys WHERE tenant_id = ? AND id = ?'
    );
  });
});

describe('createStorageAdapter', () => {
  it('should create storage adapter with all stores', () => {
    const env = createMockEnv();
    const { adapter, userStore, clientStore, sessionStore, passkeyStore } = createStorageAdapter(
      env,
      'default'
    );

    expect(adapter).toBeInstanceOf(CloudflareStorageAdapter);
    expect(userStore).toBeInstanceOf(UserStore);
    expect(clientStore).toBeInstanceOf(ClientStore);
    expect(sessionStore).toBeInstanceOf(SessionStore);
    expect(passkeyStore).toBeInstanceOf(PasskeyStore);
  });

  it('should pass explicit tenant ID to the adapter', () => {
    const env = createMockEnv();
    const { adapter } = createStorageAdapter(env, 'acme');

    expect(adapter.getConfiguredTenantId()).toBe('acme');
  });
});
