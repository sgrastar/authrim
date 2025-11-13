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
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'session_123' }), { status: 200 })),
      }),
    } as unknown as DurableObjectNamespace,
    AUTH_CODE_STORE: {
      idFromName: vi.fn().mockReturnValue('authcode-do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ exists: true }), { status: 200 })),
      }),
    } as unknown as DurableObjectNamespace,
    REFRESH_TOKEN_ROTATOR: {
      idFromName: vi.fn().mockReturnValue('refreshtoken-do-id'),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'family_123' }), { status: 200 })),
      }),
    } as unknown as DurableObjectNamespace,
    KEY_MANAGER: {} as DurableObjectNamespace,
    AUTH_CODES: {} as KVNamespace,
    STATE_STORE: {} as KVNamespace,
    NONCE_STORE: {} as KVNamespace,
    REVOKED_TOKENS: {} as KVNamespace,
    REFRESH_TOKENS: {} as KVNamespace,
    ISSUER_URL: 'https://idp.example.com',
    TOKEN_EXPIRY: '3600',
    CODE_EXPIRY: '600',
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
    adapter = new CloudflareStorageAdapter(env);
  });

  describe('Routing Logic', () => {
    it('should route session: prefix to SessionStore DO', async () => {
      await adapter.get('session:123');
      expect(env.SESSION_STORE.get).toHaveBeenCalled();
    });

    it('should route client: prefix to D1 with KV cache', async () => {
      // Mock KV cache to return null (cache miss)
      (env.CLIENTS_CACHE?.get as any).mockResolvedValue(null);
      // Mock D1 to return data
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue({ data: JSON.stringify({ client_id: 'test-client' }) }),
      });

      await adapter.get('client:test-client');
      expect(env.CLIENTS_CACHE?.get).toHaveBeenCalled();
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

    it('should route refreshtoken: prefix to RefreshTokenRotator DO', async () => {
      await adapter.get('refreshtoken:family_123');
      expect(env.REFRESH_TOKEN_ROTATOR.get).toHaveBeenCalled();
    });

    it('should fallback to KV for unknown prefixes', async () => {
      await adapter.get('unknown:key');
      expect(env.CLIENTS.get).toHaveBeenCalledWith('unknown:key');
    });
  });

  describe('Set Operations', () => {
    it('should set value with session: prefix to SessionStore DO', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 201 }));
      (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

      await adapter.set('session:123', JSON.stringify({ user_id: 'user_123', data: {} }));
      expect(mockFetch).toHaveBeenCalled();
    });

    it('should set value with client: prefix to D1 and invalidate KV cache', async () => {
      await adapter.set('client:test-client', JSON.stringify({ client_id: 'test-client' }));
      expect(env.DB.prepare).toHaveBeenCalled();
      expect(env.CLIENTS_CACHE?.delete).toHaveBeenCalled();
    });

    it('should set value with TTL to KV for unknown prefixes', async () => {
      await adapter.set('custom:key', 'value', 3600);
      expect(env.CLIENTS.put).toHaveBeenCalledWith('custom:key', 'value', { expirationTtl: 3600 });
    });
  });

  describe('Delete Operations', () => {
    it('should delete session from SessionStore DO', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
      (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

      await adapter.delete('session:123');
      expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
    });

    it('should delete client from D1 and invalidate KV cache', async () => {
      await adapter.delete('client:test-client');
      expect(env.DB.prepare).toHaveBeenCalled();
      expect(env.CLIENTS_CACHE?.delete).toHaveBeenCalled();
    });

    it('should delete from KV for unknown prefixes', async () => {
      await adapter.delete('custom:key');
      expect(env.CLIENTS.delete).toHaveBeenCalledWith('custom:key');
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
    adapter = new CloudflareStorageAdapter(env);
    userStore = new UserStore(adapter);
  });

  it('should get user by ID', async () => {
    const mockUser = { id: 'user_123', email: 'test@example.com', created_at: 1234567890 };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockUser] }),
    });

    const user = await userStore.get('user_123');
    expect(user).toEqual(mockUser);
  });

  it('should get user by email', async () => {
    const mockUser = { id: 'user_123', email: 'test@example.com', created_at: 1234567890 };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockUser] }),
    });

    const user = await userStore.getByEmail('test@example.com');
    expect(user).toEqual(mockUser);
  });

  it('should create new user', async () => {
    const newUser = { email: 'new@example.com', name: 'New User' };
    const user = await userStore.create(newUser);

    expect(user.id).toBeDefined();
    expect(user.email).toBe('new@example.com');
    expect(user.name).toBe('New User');
    expect(user.created_at).toBeDefined();
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO users'));
  });

  it('should update existing user', async () => {
    const mockUser = {
      id: 'user_123',
      email: 'test@example.com',
      email_verified: false,
      created_at: 1234567890,
      updated_at: 1234567890,
      is_active: true,
    };
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [mockUser] }),
      run: vi.fn().mockResolvedValue({ success: true }),
    });

    const updated = await userStore.update('user_123', { name: 'Updated Name' });
    expect(updated.name).toBe('Updated Name');
    expect(updated.updated_at).toBeGreaterThan(mockUser.updated_at);
  });

  it('should delete user', async () => {
    await userStore.delete('user_123');
    expect(env.DB.prepare).toHaveBeenCalledWith('DELETE FROM users WHERE id = ?');
  });

  it('should throw error when updating non-existent user', async () => {
    (env.DB.prepare as any).mockReturnValue({
      bind: vi.fn().mockReturnThis(),
      all: vi.fn().mockResolvedValue({ results: [] }),
    });

    await expect(userStore.update('non_existent', { name: 'Test' })).rejects.toThrow('User not found');
  });
});

describe('ClientStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let clientStore: ClientStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env);
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
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO oauth_clients'));
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
    expect(env.DB.prepare).toHaveBeenCalledWith('DELETE FROM oauth_clients WHERE client_id = ?');
  });

  it('should list clients with pagination', async () => {
    const mockClients = [
      { client_id: 'client_1', created_at: 1234567890, updated_at: 1234567890, redirect_uris: [], grant_types: [], response_types: [] },
      { client_id: 'client_2', created_at: 1234567891, updated_at: 1234567891, redirect_uris: [], grant_types: [], response_types: [] },
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
    adapter = new CloudflareStorageAdapter(env);
    sessionStore = new SessionStore(adapter, env);
  });

  it('should get session by ID', async () => {
    const mockSession = { id: 'session_123', user_id: 'user_123', created_at: 1234567890, expires_at: 1234567890 + 86400 };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSession), { status: 200 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    const session = await sessionStore.get('session_123');
    expect(session).toEqual(mockSession);
  });

  it('should return null for non-existent session', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    const session = await sessionStore.get('non_existent');
    expect(session).toBeNull();
  });

  it('should create new session', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'session_new', expiresAt: Date.now() + 86400000 }), { status: 201 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    const session = await sessionStore.create({ user_id: 'user_123', data: { amr: ['pwd'] } });
    expect(session.id).toBeDefined();
  });

  it('should delete session', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    await sessionStore.delete('session_123');
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE' }));
  });

  it('should list sessions by user', async () => {
    const mockSessions = [
      { id: 'session_1', user_id: 'user_123', created_at: 1234567890, expires_at: 1234567890 + 86400 },
      { id: 'session_2', user_id: 'user_123', created_at: 1234567891, expires_at: 1234567891 + 86400 },
    ];
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessions: mockSessions }), { status: 200 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    const sessions = await sessionStore.listByUser('user_123');
    expect(sessions).toHaveLength(2);
  });

  it('should extend session expiration', async () => {
    const mockSession = { id: 'session_123', user_id: 'user_123', created_at: 1234567890, expires_at: 1234567890 + 86400 + 3600 };
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(mockSession), { status: 200 }));
    (env.SESSION_STORE.get as any).mockReturnValue({ fetch: mockFetch });

    const extended = await sessionStore.extend('session_123', 3600);
    expect(extended).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
  });
});

describe('PasskeyStore', () => {
  let env: Env;
  let adapter: CloudflareStorageAdapter;
  let passkeyStore: PasskeyStore;

  beforeEach(() => {
    env = createMockEnv();
    adapter = new CloudflareStorageAdapter(env);
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
      { id: 'passkey_1', user_id: 'user_123', credential_id: 'cred_1', public_key: 'pubkey1', counter: 0, created_at: 1234567890 },
      { id: 'passkey_2', user_id: 'user_123', credential_id: 'cred_2', public_key: 'pubkey2', counter: 0, created_at: 1234567891 },
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
      run: vi.fn().mockResolvedValue({ success: true }),
      all: vi.fn().mockResolvedValue({ results: [mockPasskey] }),
    });

    const updated = await passkeyStore.updateCounter('passkey_123', 5);
    expect(updated.counter).toBe(5);
  });

  it('should delete passkey', async () => {
    await passkeyStore.delete('passkey_123');
    expect(env.DB.prepare).toHaveBeenCalledWith('DELETE FROM passkeys WHERE id = ?');
  });
});

describe('createStorageAdapter', () => {
  it('should create storage adapter with all stores', () => {
    const env = createMockEnv();
    const { adapter, userStore, clientStore, sessionStore, passkeyStore } = createStorageAdapter(env);

    expect(adapter).toBeInstanceOf(CloudflareStorageAdapter);
    expect(userStore).toBeInstanceOf(UserStore);
    expect(clientStore).toBeInstanceOf(ClientStore);
    expect(sessionStore).toBeInstanceOf(SessionStore);
    expect(passkeyStore).toBeInstanceOf(PasskeyStore);
  });
});
