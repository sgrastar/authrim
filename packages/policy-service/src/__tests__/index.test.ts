/**
 * Policy Service API Tests
 *
 * Tests for the policy-service REST API endpoints.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import app from '../index';

// Mock environment
const mockEnv = {
  POLICY_API_SECRET: 'test-secret-key',
  VERSION_MANAGER: {
    idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
    get: vi.fn(() => ({
      fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ uuid: 'test-uuid' })))),
    })),
  },
  CODE_VERSION_UUID: '',
};

// Helper to create request with auth
function createRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    withAuth?: boolean;
  } = {}
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.withAuth !== false) {
    headers['Authorization'] = `Bearer ${mockEnv.POLICY_API_SECRET}`;
  }

  return new Request(`https://test.example.com${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Policy Service API', () => {
  describe('GET /policy/health', () => {
    it('should return health status', async () => {
      const req = createRequest('/policy/health', { withAuth: false });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('policy-service');
      expect(body.version).toBe('0.1.0');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /api/rebac/health', () => {
    it('should return ReBAC health status (limited when DB/ReBAC not configured)', async () => {
      const req = createRequest('/api/rebac/health', { withAuth: false });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      // Status is 'limited' when ENABLE_REBAC is not set and DB is not configured
      expect(body.status).toBe('limited');
      expect(body.service).toBe('rebac-service');
      expect(body.enabled).toBe(false);
      expect(body.database).toBe(false);
    });

    it('should return ok status when ReBAC is enabled and DB is configured', async () => {
      const mockEnvWithRebac = {
        ...mockEnv,
        ENABLE_REBAC: 'true',
        DB: {
          prepare: vi.fn(() => ({
            bind: vi.fn().mockReturnThis(),
            all: vi.fn(() => Promise.resolve({ results: [] })),
            run: vi.fn(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
          })),
        },
      };
      const req = createRequest('/api/rebac/health', { withAuth: false });
      const res = await app.fetch(req, mockEnvWithRebac);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.enabled).toBe(true);
      expect(body.database).toBe(true);
    });
  });

  describe('POST /policy/evaluate', () => {
    it('should return 401 without authorization', async () => {
      const req = createRequest('/policy/evaluate', {
        method: 'POST',
        body: {},
        withAuth: false,
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('unauthorized');
    });

    it('should return 400 for missing required fields', async () => {
      const req = createRequest('/policy/evaluate', {
        method: 'POST',
        body: {},
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('should evaluate policy with valid context', async () => {
      const req = createRequest('/policy/evaluate', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [{ name: 'system_admin', scope: 'global' }],
          },
          resource: {
            type: 'document',
            id: 'doc_456',
          },
          action: {
            name: 'read',
          },
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
      expect(body.decidedBy).toBe('system_admin_full_access');
    });

    it('should deny access for non-admin user', async () => {
      const req = createRequest('/policy/evaluate', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [{ name: 'end_user', scope: 'global' }],
          },
          resource: {
            type: 'document',
            id: 'doc_456',
            ownerId: 'user_789',
          },
          action: {
            name: 'read',
          },
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(false);
    });
  });

  describe('POST /policy/check-role', () => {
    it('should return 401 without authorization', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {},
        withAuth: false,
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return 400 when subject is missing', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: { role: 'admin' },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('should return 400 when neither role nor roles is provided', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {
          subject: { id: 'user_123', roles: [] },
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should check single role successfully', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [{ name: 'admin', scope: 'global' }],
          },
          role: 'admin',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasRole).toBe(true);
      expect(body.activeRoles).toContain('admin');
    });

    it('should check multiple roles with any mode', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [{ name: 'editor', scope: 'global' }],
          },
          roles: ['admin', 'editor'],
          mode: 'any',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasRole).toBe(true);
    });

    it('should check multiple roles with all mode', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [
              { name: 'admin', scope: 'global' },
              { name: 'editor', scope: 'global' },
            ],
          },
          roles: ['admin', 'editor'],
          mode: 'all',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasRole).toBe(true);
    });

    it('should convert claims to subject', async () => {
      const req = createRequest('/policy/check-role', {
        method: 'POST',
        body: {
          subject: {
            claims: {
              sub: 'user_123',
              authrim_roles: ['admin'],
            },
          },
          role: 'admin',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.hasRole).toBe(true);
    });
  });

  describe('POST /policy/check-access', () => {
    it('should return 401 without authorization', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: {},
        withAuth: false,
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return 400 for missing required fields', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: { resourceType: 'document' },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should return 400 when neither claims nor roles is provided', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: {
          resourceType: 'document',
          resourceId: 'doc_123',
          action: 'read',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should check access with claims', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: {
          claims: {
            sub: 'user_123',
            authrim_roles: ['system_admin'],
          },
          resourceType: 'document',
          resourceId: 'doc_456',
          action: 'read',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });

    it('should check access with direct roles', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: {
          subjectId: 'user_123',
          roles: [{ name: 'system_admin', scope: 'global' }],
          resourceType: 'document',
          resourceId: 'doc_456',
          action: 'read',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });

    it('should check access for resource owner', async () => {
      const req = createRequest('/policy/check-access', {
        method: 'POST',
        body: {
          subjectId: 'user_123',
          roles: [{ name: 'end_user', scope: 'global' }],
          resourceType: 'document',
          resourceId: 'doc_456',
          resourceOwnerId: 'user_123',
          action: 'read',
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });
  });

  describe('POST /policy/is-admin', () => {
    it('should return 401 without authorization', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: {},
        withAuth: false,
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return 400 when neither claims nor roles is provided', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: {},
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should return true for admin role', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: { roles: ['admin'] },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isAdmin).toBe(true);
    });

    it('should return true for system_admin role', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: { roles: ['system_admin'] },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isAdmin).toBe(true);
    });

    it('should return false for non-admin role', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: { roles: ['end_user'] },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isAdmin).toBe(false);
    });

    it('should check admin with claims', async () => {
      const req = createRequest('/policy/is-admin', {
        method: 'POST',
        body: {
          claims: {
            sub: 'user_123',
            authrim_roles: ['org_admin'],
          },
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.isAdmin).toBe(true);
    });
  });

  describe('POST /api/rebac/check', () => {
    it('should return 401 without authorization', async () => {
      const req = createRequest('/api/rebac/check', {
        method: 'POST',
        body: {},
        withAuth: false,
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should return 503 when ReBAC is not enabled', async () => {
      const req = createRequest('/api/rebac/check', {
        method: 'POST',
        body: { user_id: 'user:123', relation: 'viewer', object: 'document:doc_1' },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('feature_disabled');
    });

    it('should return 400 for missing required fields when ReBAC is enabled', async () => {
      const mockEnvWithRebac = {
        ...mockEnv,
        ENABLE_REBAC: 'true',
        DB: {
          prepare: vi.fn(() => ({
            bind: vi.fn().mockReturnThis(),
            all: vi.fn(() => Promise.resolve({ results: [] })),
            run: vi.fn(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
          })),
        },
      };
      const req = createRequest('/api/rebac/check', {
        method: 'POST',
        body: { user_id: 'user:123' }, // missing relation and object
      });
      const res = await app.fetch(req, mockEnvWithRebac);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid_request');
    });

    it('should perform ReBAC check when enabled with DB', async () => {
      const mockEnvWithRebac = {
        ...mockEnv,
        ENABLE_REBAC: 'true',
        DB: {
          prepare: vi.fn(() => ({
            bind: vi.fn().mockReturnThis(),
            all: vi.fn(() => Promise.resolve({ results: [] })), // No relationships found
            run: vi.fn(() => Promise.resolve({ success: true, meta: { changes: 0 } })),
          })),
        },
      };
      const req = createRequest('/api/rebac/check', {
        method: 'POST',
        body: {
          user_id: 'user:user_123',
          relation: 'viewer',
          object: 'document:doc_456',
        },
      });
      const res = await app.fetch(req, mockEnvWithRebac);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(false); // No relationships = not allowed
    });
  });

  describe('Root route (workers.dev compatibility)', () => {
    it('should handle /health at root level', async () => {
      const req = createRequest('/health', { withAuth: false });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.service).toBe('policy-service');
    });

    it('should handle /evaluate at root level', async () => {
      const req = createRequest('/evaluate', {
        method: 'POST',
        body: {
          subject: {
            id: 'user_123',
            roles: [{ name: 'system_admin', scope: 'global' }],
          },
          resource: { type: 'doc', id: 'doc_1' },
          action: { name: 'read' },
        },
      });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.allowed).toBe(true);
    });
  });

  describe('404 handler', () => {
    it('should return 404 for unknown paths', async () => {
      const req = createRequest('/unknown/path', { withAuth: false });
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('not_found');
      expect(body.path).toBe('/unknown/path');
    });
  });
});
