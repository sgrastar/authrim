/**
 * Check API Validation Tests
 *
 * Tests for request validation in Check API routes:
 * - POST /api/check - Single permission check
 * - POST /api/check/batch - Batch permission check
 *
 * Validates:
 * - Required fields (subject_id, permission)
 * - rebac parameters (relation, object)
 * - contextual_tuples validation (array, size limit, tuple fields)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../index';
import { createPolicyRuntimeEnv } from './helpers/runtime-env';

// Mock environment with all required services
const createMockEnv = () =>
  createPolicyRuntimeEnv(
    {
      prepare: vi.fn(() => ({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn(() => Promise.resolve({ results: [] })),
        first: vi.fn(() => Promise.resolve(null)),
        run: vi.fn(() => Promise.resolve({ success: true })),
      })),
      batch: vi.fn(() => Promise.resolve([])),
    } as unknown as D1Database,
    {
      POLICY_API_SECRET: 'test-secret-key',
      ENABLE_CHECK_API: 'true',
      DEFAULT_TENANT_ID: 'default',
      VERSION_MANAGER: {
        idFromName: vi.fn(() => ({ toString: () => 'mock-id' })),
        get: vi.fn(() => ({
          fetch: vi.fn(() => Promise.resolve(new Response(JSON.stringify({ uuid: 'test-uuid' })))),
        })),
      },
      CODE_VERSION_UUID: '',
      CHECK_CACHE_KV: {
        get: vi.fn(() => Promise.resolve(null)),
        put: vi.fn(() => Promise.resolve()),
        getWithMetadata: vi.fn(() => Promise.resolve({ value: null, metadata: null })),
      },
    }
  );

// Helper to create authenticated request
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
    headers['Authorization'] = 'Bearer test-secret-key';
  }

  return new Request(`https://test.example.com${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Check API Validation', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    mockEnv = createMockEnv();
    vi.clearAllMocks();
  });

  // ===========================================================================
  // POST /api/check - Required Fields
  // ===========================================================================

  describe('POST /api/check - Required Fields', () => {
    it('should reject request without subject_id', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          permission: 'documents:read',
        },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
    });

    it('should reject request without permission', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
        },
      });

      const res = await app.fetch(req, mockEnv);
      const body = (await res.json()) as { error: string };

      expect(res.status).toBe(400);
      expect(body.error).toBe('invalid_request');
    });

    it('should reject request with empty subject_id', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: '',
          permission: 'documents:read',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject request with invalid permission format', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: '', // Empty permission
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // POST /api/check - ReBAC Validation
  // ===========================================================================

  describe('POST /api/check - ReBAC Validation', () => {
    it('should reject rebac without relation', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            object: 'document:doc_456',
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject rebac without object', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject rebac with non-string relation', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 123, // Should be string
            object: 'document:doc_456',
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject rebac with non-string object', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: ['document', 'doc_456'], // Should be string
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });
  });

  // ===========================================================================
  // POST /api/check - Contextual Tuples Validation
  // ===========================================================================

  describe('POST /api/check - Contextual Tuples Validation', () => {
    it('should reject non-array contextual_tuples', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: 'not-an-array',
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject contextual_tuples exceeding limit (100)', async () => {
      // Create 101 tuples to exceed the limit
      const tuples = Array.from({ length: 101 }, (_, i) => ({
        user_id: `user_${i}`,
        relation: 'viewer',
        object: `document:doc_${i}`,
      }));

      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: tuples,
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject tuple without user_id', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: [
              {
                relation: 'viewer',
                object: 'document:doc_789',
              },
            ],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject tuple without relation', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: [
              {
                user_id: 'user_999',
                object: 'document:doc_789',
              },
            ],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject tuple without object', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: [
              {
                user_id: 'user_999',
                relation: 'viewer',
              },
            ],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject tuple that is not an object', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: ['not-an-object', null, 123],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should accept empty contextual_tuples array', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: [],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      // Should not fail validation (may return 200 or other status based on actual check)
      expect(res.status).not.toBe(400);
    });

    it('should accept valid contextual_tuples', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
          rebac: {
            relation: 'viewer',
            object: 'document:doc_456',
            contextual_tuples: [
              {
                user_id: 'user_999',
                relation: 'editor',
                object: 'document:doc_789',
              },
              {
                user_id: 'user_888',
                relation: 'owner',
                object: 'folder:folder_123',
              },
            ],
          },
        },
      });

      const res = await app.fetch(req, mockEnv);

      // Should pass validation
      expect(res.status).not.toBe(400);
    });
  });

  // ===========================================================================
  // POST /api/check/batch - Validation
  // ===========================================================================

  describe('POST /api/check/batch - Validation', () => {
    it('should reject batch without checks array', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {},
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch with empty checks array', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch with checks exceeding limit', async () => {
      // Default limit is 100
      const checks = Array.from({ length: 101 }, () => ({
        subject_id: 'user_123',
        permission: 'documents:read',
      }));

      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: { checks },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch check without subject_id', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [
            {
              permission: 'documents:read',
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch check without permission', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [
            {
              subject_id: 'user_123',
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch check with invalid rebac', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [
            {
              subject_id: 'user_123',
              permission: 'documents:read',
              rebac: {
                // Missing relation and object
              },
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should reject batch check with invalid contextual_tuples', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [
            {
              subject_id: 'user_123',
              permission: 'documents:read',
              rebac: {
                relation: 'viewer',
                object: 'document:doc_456',
                contextual_tuples: [
                  {
                    // Missing required fields
                    user_id: 'user_999',
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(400);
    });

    it('should accept valid batch request', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        body: {
          checks: [
            {
              subject_id: 'user_123',
              permission: 'documents:read',
            },
            {
              subject_id: 'user_456',
              permission: 'projects:write',
              rebac: {
                relation: 'editor',
                object: 'project:proj_123',
                contextual_tuples: [
                  {
                    user_id: 'user_789',
                    relation: 'viewer',
                    object: 'project:proj_123',
                  },
                ],
              },
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      // Should pass validation
      expect(res.status).not.toBe(400);
    });
  });

  // ===========================================================================
  // Authentication Required
  // ===========================================================================

  describe('Authentication Required', () => {
    it('should reject /api/check without auth', async () => {
      const req = createRequest('/api/check', {
        method: 'POST',
        withAuth: false,
        body: {
          subject_id: 'user_123',
          permission: 'documents:read',
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });

    it('should reject /api/check/batch without auth', async () => {
      const req = createRequest('/api/check/batch', {
        method: 'POST',
        withAuth: false,
        body: {
          checks: [
            {
              subject_id: 'user_123',
              permission: 'documents:read',
            },
          ],
        },
      });

      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(401);
    });
  });
});
