/**
 * Status List Route Tests
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { Hono } from 'hono';
import { statusListRoute, statusListJsonRoute } from '../status-list';
import type { Env } from '../../../types';
import { exportJWK, generateKeyPair } from 'jose';
import type { JWK } from 'jose';

// Mock database result
const mockListData = {
  id: 'sl_r_tenant1_abc123',
  tenant_id: 'tenant1',
  purpose: 'revocation' as const,
  encoded_list: 'H4sIAAAAAAAAA2NgGAUjHQAAAfQB9A',
  updated_at: '2024-01-01T00:00:00.000Z',
};

// Will be populated in beforeAll
let mockKeyData: {
  kid: string;
  privateKeyJwk: JWK;
  publicKeyJwk: JWK;
  algorithm: string;
};

// Create mock environment - creates fresh Response each time
function createMockEnv(listData: typeof mockListData | null = mockListData): Env {
  return {
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(listData),
        }),
      }),
    } as unknown as D1Database,
    AUTHRIM_CONFIG: {} as KVNamespace,
    VP_REQUEST_STORE: {} as DurableObjectNamespace,
    CREDENTIAL_OFFER_STORE: {} as DurableObjectNamespace,
    KEY_MANAGER: {
      idFromName: vi.fn().mockReturnValue({ toString: () => 'key-manager-id' }),
      get: vi.fn().mockReturnValue({
        // Create fresh Response for each fetch call
        fetch: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(new Response(JSON.stringify(mockKeyData), { status: 200 }))
          ),
      }),
    } as unknown as DurableObjectNamespace,
    POLICY_SERVICE: {} as Fetcher,
    VERIFIER_IDENTIFIER: 'https://verifier.example.com',
    HAIP_POLICY_VERSION: 'final-1.0',
    VP_REQUEST_EXPIRY_SECONDS: '300',
    NONCE_EXPIRY_SECONDS: '300',
    ISSUER_IDENTIFIER: 'https://issuer.example.com',
    CREDENTIAL_OFFER_EXPIRY_SECONDS: '300',
    C_NONCE_EXPIRY_SECONDS: '300',
  };
}

describe('Status List Routes', () => {
  let app: Hono<{ Bindings: Env }>;
  let mockEnv: Env;

  // Generate real EC keys for testing
  beforeAll(async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    const publicJwk = await exportJWK(publicKey);

    mockKeyData = {
      kid: 'key-1',
      privateKeyJwk: privateJwk,
      publicKeyJwk: publicJwk,
      algorithm: 'ES256',
    };
  });

  beforeEach(() => {
    mockEnv = createMockEnv();
    app = new Hono<{ Bindings: Env }>();
    app.get('/vci/status/:listId', statusListRoute);
    app.get('/vci/status/:listId/json', statusListJsonRoute);
    vi.clearAllMocks();
  });

  describe('GET /vci/status/:listId', () => {
    it('should return status list credential JWT', async () => {
      const res = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv
      );

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/statuslist+jwt');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(res.headers.get('ETag')).toBeTruthy();

      const jwt = await res.text();
      expect(jwt).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

      // Decode and verify JWT payload
      const parts = jwt.split('.');
      const header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

      expect(header.typ).toBe('statuslist+jwt');
      expect(header.alg).toBe('ES256');
      expect(header.kid).toBe('key-1');

      expect(payload.iss).toBe('did:web:issuer.example.com');
      expect(payload.vc.type).toContain('BitstringStatusListCredential');
      expect(payload.vc.credentialSubject.type).toBe('BitstringStatusList');
      expect(payload.vc.credentialSubject.statusPurpose).toBe('revocation');
      expect(payload.vc.credentialSubject.encodedList).toBe(mockListData.encoded_list);
    });

    it('should return 304 Not Modified when ETag matches', async () => {
      // First request to get ETag
      const res1 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv
      );

      const etag = res1.headers.get('ETag');
      expect(etag).toBeTruthy();

      // Second request with If-None-Match
      const res2 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: {
            host: 'issuer.example.com',
            'If-None-Match': etag!,
          },
        },
        mockEnv
      );

      expect(res2.status).toBe(304);
      expect(res2.headers.get('ETag')).toBe(etag);
      expect(res2.headers.get('Cache-Control')).toBe('public, max-age=300');
    });

    it('should return 404 for non-existent list', async () => {
      const mockEnvNotFound = createMockEnv(null);

      const res = await app.request(
        '/vci/status/non-existent',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnvNotFound
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not_found');
    });

    it('should include correct cache headers', async () => {
      const res = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv
      );

      expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    });
  });

  describe('GET /vci/status/:listId/json', () => {
    it('should return status list data as JSON', async () => {
      const res = await app.request('/vci/status/sl_r_tenant1_abc123/json', {}, mockEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');

      const body = (await res.json()) as typeof mockListData;
      expect(body.id).toBe(mockListData.id);
      expect(body.tenant_id).toBe(mockListData.tenant_id);
      expect(body.purpose).toBe(mockListData.purpose);
      expect(body.encoded_list).toBe(mockListData.encoded_list);
    });

    it('should return 404 for non-existent list', async () => {
      const mockEnvNotFound = createMockEnv(null);

      const res = await app.request('/vci/status/non-existent/json', {}, mockEnvNotFound);

      expect(res.status).toBe(404);
    });
  });

  describe('ETag Calculation', () => {
    it('should generate consistent ETag for same data', async () => {
      // Create fresh envs for each request
      const mockEnv1 = createMockEnv();
      const mockEnv2 = createMockEnv();

      const res1 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv1
      );

      const res2 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv2
      );

      expect(res1.headers.get('ETag')).toBe(res2.headers.get('ETag'));
    });

    it('should generate different ETag for different data', async () => {
      const mockEnv1 = createMockEnv();
      const res1 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnv1
      );

      // Modify mock data
      const modifiedListData = {
        ...mockListData,
        encoded_list: 'H4sIAAAAAAAAA2NgGAUjHQAAAfQB9B',
        updated_at: '2024-01-02T00:00:00.000Z',
      };

      const mockEnvModified = createMockEnv(modifiedListData);

      const res2 = await app.request(
        '/vci/status/sl_r_tenant1_abc123',
        {
          headers: { host: 'issuer.example.com' },
        },
        mockEnvModified
      );

      expect(res1.headers.get('ETag')).not.toBe(res2.headers.get('ETag'));
    });
  });
});
