import { describe, it, expect, beforeEach } from 'vitest';
import {
  storeAuthCode,
  getAuthCode,
  deleteAuthCode,
  storeState,
  getState,
  deleteState,
  storeNonce,
  getNonce,
  deleteNonce,
  storeClient,
  getClient,
  type AuthCodeData,
} from '../../src/utils/kv';
import type { Env } from '../../src/types/env';

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
  let clientsKV: MockKVNamespace;

  beforeEach(() => {
    authCodesKV = new MockKVNamespace();
    stateStoreKV = new MockKVNamespace();
    nonceStoreKV = new MockKVNamespace();
    clientsKV = new MockKVNamespace();

    env = {
      AUTH_CODES: authCodesKV as unknown as KVNamespace,
      STATE_STORE: stateStoreKV as unknown as KVNamespace,
      NONCE_STORE: nonceStoreKV as unknown as KVNamespace,
      CLIENTS: clientsKV as unknown as KVNamespace,
      ISSUER_URL: 'http://localhost:8787',
      TOKEN_EXPIRY: '3600',
      CODE_EXPIRY: '120',
      STATE_EXPIRY: '300',
      NONCE_EXPIRY: '300',
    };
  });

  describe('Authorization Code Operations', () => {
    it('should store and retrieve authorization code', async () => {
      const code = 'test-auth-code-123';
      const data: AuthCodeData = {
        client_id: 'test-client',
        redirect_uri: 'http://localhost:3000/callback',
        scope: 'openid profile',
        timestamp: Date.now(),
      };

      await storeAuthCode(env, code, data);
      const retrieved = await getAuthCode(env, code);

      expect(retrieved).toEqual(data);
    });

    it('should return null for non-existent authorization code', async () => {
      const retrieved = await getAuthCode(env, 'non-existent-code');
      expect(retrieved).toBeNull();
    });

    it('should delete authorization code', async () => {
      const code = 'test-auth-code-delete';
      const data: AuthCodeData = {
        client_id: 'test-client',
        redirect_uri: 'http://localhost:3000/callback',
        scope: 'openid',
        timestamp: Date.now(),
      };

      await storeAuthCode(env, code, data);
      await deleteAuthCode(env, code);

      const retrieved = await getAuthCode(env, code);
      expect(retrieved).toBeNull();
    });

    it('should store authorization code with nonce', async () => {
      const code = 'test-auth-code-with-nonce';
      const data: AuthCodeData = {
        client_id: 'test-client',
        redirect_uri: 'http://localhost:3000/callback',
        scope: 'openid',
        nonce: 'test-nonce-123',
        timestamp: Date.now(),
      };

      await storeAuthCode(env, code, data);
      const retrieved = await getAuthCode(env, code);

      expect(retrieved?.nonce).toBe('test-nonce-123');
    });
  });

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

  describe('Client Metadata Operations', () => {
    it('should store and retrieve client metadata', async () => {
      const clientId = 'test-client-123';
      const clientData = {
        client_name: 'Test Client',
        redirect_uris: ['http://localhost:3000/callback'],
        grant_types: ['authorization_code'],
      };

      await storeClient(env, clientId, clientData);
      const retrieved = await getClient(env, clientId);

      expect(retrieved).toEqual(clientData);
    });

    it('should return null for non-existent client', async () => {
      const retrieved = await getClient(env, 'non-existent-client');
      expect(retrieved).toBeNull();
    });
  });
});
