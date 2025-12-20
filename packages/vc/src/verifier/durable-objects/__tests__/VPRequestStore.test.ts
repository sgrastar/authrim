/**
 * VP Request Store Durable Object Tests
 *
 * Tests for VP request state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VPRequestStore } from '../VPRequestStore';
import type { VPRequestState } from '../../../types';

// Mock storage
const createMockStorage = () => {
  const storage = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: string): Promise<unknown> => {
      return storage.get(key);
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      storage.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      return storage.delete(key);
    }),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
    getAlarm: vi.fn(),
    _storage: storage,
  };
};

// Mock DurableObjectState
const createMockState = () => {
  const mockStorage = createMockStorage();
  return {
    storage: mockStorage,
    id: { toString: () => 'test-id' },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn((fn: () => Promise<void>) => fn()),
    _mockStorage: mockStorage,
  } as unknown as DurableObjectState & { _mockStorage: ReturnType<typeof createMockStorage> };
};

describe('VPRequestStore', () => {
  let state: ReturnType<typeof createMockState>;
  let store: VPRequestStore;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createMockState();
    store = new VPRequestStore(state);
  });

  describe('/create', () => {
    it('should create a new VP request', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000, // 5 minutes
      };

      const request = new Request('https://internal/create', {
        method: 'POST',
        body: JSON.stringify(vpRequest),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { success: boolean };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(state._mockStorage.put).toHaveBeenCalledWith('request', vpRequest);
      expect(state._mockStorage.setAlarm).toHaveBeenCalledWith(vpRequest.expiresAt);
    });

    it('should store nonce for single-use check', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'unique-nonce',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };

      const request = new Request('https://internal/create', {
        method: 'POST',
        body: JSON.stringify(vpRequest),
      });

      await store.fetch(request);

      expect(state._mockStorage.put).toHaveBeenCalledWith(
        `nonce:${vpRequest.nonce}`,
        expect.objectContaining({
          consumed: false,
        })
      );
    });
  });

  describe('/get', () => {
    it('should return stored request', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };

      state._mockStorage._storage.set('request', vpRequest);

      const request = new Request('https://internal/get');
      const response = await store.fetch(request);
      const data = (await response.json()) as VPRequestState;

      expect(response.status).toBe(200);
      expect(data.id).toBe(vpRequest.id);
      expect(data.nonce).toBe(vpRequest.nonce);
    });

    it('should return 404 when request not found', async () => {
      const request = new Request('https://internal/get');
      const response = await store.fetch(request);
      const data = (await response.json()) as { error: string };

      expect(response.status).toBe(404);
      expect(data.error).toBe('Not found');
    });
  });

  describe('/update', () => {
    it('should update existing request', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };

      state._mockStorage._storage.set('request', vpRequest);

      const updates = {
        status: 'verified' as const,
        verifiedClaims: { name: 'John Doe' },
      };

      const request = new Request('https://internal/update', {
        method: 'POST',
        body: JSON.stringify(updates),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { success: boolean };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      // Check that the request was updated
      const storedRequest = state._mockStorage._storage.get('request') as VPRequestState;
      expect(storedRequest.status).toBe('verified');
      expect(storedRequest.verifiedClaims).toEqual({ name: 'John Doe' });
    });

    it('should return 404 when request not found', async () => {
      const request = new Request('https://internal/update', {
        method: 'POST',
        body: JSON.stringify({ status: 'verified' }),
      });

      const response = await store.fetch(request);
      expect(response.status).toBe(404);
    });
  });

  describe('/update-status', () => {
    it('should update only status', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 300000,
      };

      state._mockStorage._storage.set('request', vpRequest);

      const request = new Request('https://internal/update-status', {
        method: 'POST',
        body: JSON.stringify({ status: 'expired' }),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { success: boolean };

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);

      const storedRequest = state._mockStorage._storage.get('request') as VPRequestState;
      expect(storedRequest.status).toBe('expired');
    });
  });

  describe('/consume-nonce', () => {
    it('should consume nonce successfully', async () => {
      const nonce = 'test-nonce';
      state._mockStorage._storage.set(`nonce:${nonce}`, {
        createdAt: Date.now(),
        consumed: false,
      });

      const request = new Request('https://internal/consume-nonce', {
        method: 'POST',
        body: JSON.stringify({ nonce }),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { consumed: boolean };

      expect(response.status).toBe(200);
      expect(data.consumed).toBe(true);

      // Check nonce is marked as consumed
      const nonceData = state._mockStorage._storage.get(`nonce:${nonce}`) as {
        consumed: boolean;
        consumedAt?: number;
      };
      expect(nonceData.consumed).toBe(true);
      expect(nonceData.consumedAt).toBeDefined();
    });

    it('should reject already consumed nonce', async () => {
      const nonce = 'consumed-nonce';
      state._mockStorage._storage.set(`nonce:${nonce}`, {
        createdAt: Date.now(),
        consumed: true,
        consumedAt: Date.now(),
      });

      const request = new Request('https://internal/consume-nonce', {
        method: 'POST',
        body: JSON.stringify({ nonce }),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { consumed: boolean; error: string };

      expect(response.status).toBe(200);
      expect(data.consumed).toBe(false);
      expect(data.error).toContain('already consumed');
    });

    it('should reject unknown nonce', async () => {
      const request = new Request('https://internal/consume-nonce', {
        method: 'POST',
        body: JSON.stringify({ nonce: 'unknown-nonce' }),
      });

      const response = await store.fetch(request);
      const data = (await response.json()) as { consumed: boolean; error: string };

      expect(response.status).toBe(200);
      expect(data.consumed).toBe(false);
      expect(data.error).toContain('not found');
    });
  });

  describe('alarm', () => {
    it('should mark pending request as expired', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() - 1000, // Already expired
      };

      state._mockStorage._storage.set('request', vpRequest);

      await store.alarm();

      const storedRequest = state._mockStorage._storage.get('request') as VPRequestState;
      expect(storedRequest.status).toBe('expired');
    });

    it('should not modify non-pending requests', async () => {
      const vpRequest: VPRequestState = {
        id: 'request-1',
        tenantId: 'tenant-1',
        clientId: 'client-1',
        nonce: 'nonce-123',
        responseUri: 'https://example.com/callback',
        responseMode: 'direct_post',
        status: 'verified',
        createdAt: Date.now(),
        expiresAt: Date.now() - 1000,
      };

      state._mockStorage._storage.set('request', vpRequest);

      await store.alarm();

      const storedRequest = state._mockStorage._storage.get('request') as VPRequestState;
      expect(storedRequest.status).toBe('verified'); // Unchanged
    });
  });

  describe('404 handling', () => {
    it('should return 404 for unknown paths', async () => {
      const request = new Request('https://internal/unknown-path');
      const response = await store.fetch(request);

      expect(response.status).toBe(404);
    });
  });
});
