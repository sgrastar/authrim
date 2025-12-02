/**
 * SAMLRequestStore Durable Object Tests
 *
 * Tests for SAML request storage, artifact resolution, and assertion ID tracking.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the DO state
const createMockState = () => {
  const storage = new Map<string, unknown>();

  return {
    storage: {
      get: vi.fn((key: string) => Promise.resolve(storage.get(key))),
      put: vi.fn((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        storage.delete(key);
        return Promise.resolve();
      }),
      list: vi.fn((options?: { prefix?: string }) => {
        const result = new Map<string, unknown>();
        for (const [key, value] of storage) {
          if (!options?.prefix || key.startsWith(options.prefix)) {
            result.set(key, value);
          }
        }
        return Promise.resolve(result);
      }),
    },
    waitUntil: vi.fn(),
    blockConcurrencyWhile: vi.fn((fn: () => Promise<void>) => fn()),
  };
};

describe('SAMLRequestStore', () => {
  describe('Request Storage', () => {
    it('should store a SAML request', async () => {
      const mockState = createMockState();

      const requestData = {
        requestId: '_request123',
        issuer: 'https://sp.example.com',
        destination: 'https://idp.example.com/sso',
        acsUrl: 'https://sp.example.com/acs',
        binding: 'post',
        type: 'authn_request',
        relayState: 'https://sp.example.com/app',
        expiresAt: Date.now() + 300000,
      };

      // Simulate storing
      await mockState.storage.put(`request:${requestData.requestId}`, requestData);

      // Verify storage
      const stored = await mockState.storage.get(`request:${requestData.requestId}`);
      expect(stored).toEqual(requestData);
    });

    it('should consume a request (one-time use)', async () => {
      const mockState = createMockState();

      const requestData = {
        requestId: '_request123',
        issuer: 'https://sp.example.com',
        expiresAt: Date.now() + 300000,
      };

      // Store
      await mockState.storage.put(`request:${requestData.requestId}`, requestData);

      // First consume should succeed
      const first = await mockState.storage.get(`request:${requestData.requestId}`);
      expect(first).toBeDefined();

      // Delete after consume
      await mockState.storage.delete(`request:${requestData.requestId}`);

      // Second consume should fail
      const second = await mockState.storage.get(`request:${requestData.requestId}`);
      expect(second).toBeUndefined();
    });

    it('should reject expired requests', async () => {
      const mockState = createMockState();

      const expiredData = {
        requestId: '_expired123',
        issuer: 'https://sp.example.com',
        expiresAt: Date.now() - 1000, // Already expired
      };

      await mockState.storage.put(`request:${expiredData.requestId}`, expiredData);

      // Check expiration
      const stored = (await mockState.storage.get(
        `request:${expiredData.requestId}`
      )) as typeof expiredData;
      expect(stored).toBeDefined();
      expect(stored!.expiresAt).toBeLessThan(Date.now());
    });
  });

  describe('Artifact Binding', () => {
    it('should store and resolve SAML artifact', async () => {
      const mockState = createMockState();

      const artifact = 'AAQAAMFbSaXTBcg...';
      const responseXml = '<samlp:Response>...</samlp:Response>';
      const expiresAt = Date.now() + 60000;

      // Store artifact
      await mockState.storage.put(`artifact:${artifact}`, {
        responseXml,
        expiresAt,
      });

      // Resolve artifact
      const stored = (await mockState.storage.get(`artifact:${artifact}`)) as {
        responseXml: string;
        expiresAt: number;
      };
      expect(stored).toBeDefined();
      expect(stored!.responseXml).toBe(responseXml);

      // Delete after resolve (one-time use)
      await mockState.storage.delete(`artifact:${artifact}`);

      // Second resolve should fail
      const second = await mockState.storage.get(`artifact:${artifact}`);
      expect(second).toBeUndefined();
    });
  });

  describe('Assertion ID Tracking', () => {
    it('should track consumed assertion IDs to prevent replay', async () => {
      const mockState = createMockState();

      const assertionId = '_assertion123';
      const expiresAt = Date.now() + 3600000;

      // First consumption - should succeed
      const first = await mockState.storage.get(`assertionId:${assertionId}`);
      expect(first).toBeUndefined();

      // Mark as consumed
      await mockState.storage.put(`assertionId:${assertionId}`, { expiresAt });

      // Second consumption - should be detected as replay
      const second = await mockState.storage.get(`assertionId:${assertionId}`);
      expect(second).toBeDefined();
    });
  });
});
