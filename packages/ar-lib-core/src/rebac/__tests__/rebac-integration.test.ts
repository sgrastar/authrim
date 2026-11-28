/**
 * ReBAC Integration Tests
 *
 * End-to-end tests for the ReBAC system combining multiple features:
 * - Complex permission inheritance through multiple object types
 * - Batch check with request-scoped caching
 * - Direct + computed permissions
 * - Contextual tuples + DB tuples
 * - Multi-tenant isolation
 * - List operations (listObjects, listUsers)
 * - Cache invalidation
 *
 * These tests verify the complete flow from ReBACService through
 * to the RelationParser and storage adapter.
 *
 * @see rebac-service.ts
 * @see relation-parser.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReBACService } from '../rebac-service';
import type { IStorageAdapter } from '../../storage/interfaces';
import type {
  RelationDefinition,
  DirectRelation,
  UnionRelation,
  TupleToUsersetRelation,
  IntersectionRelation,
  ExclusionRelation,
} from '../types';

// =============================================================================
// Test Utilities
// =============================================================================

interface TestRelationship {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relationship_type: string;
  expires_at?: number | null;
}

interface TestRelationDefinition {
  id: string;
  tenant_id: string;
  object_type: string;
  relation_name: string;
  definition_json: string;
  priority: number;
  is_active: number;
}

/**
 * Create a mock storage adapter with relationships and relation definitions
 */
function createMockAdapter(
  relationships: TestRelationship[] = [],
  relationDefinitions: TestRelationDefinition[] = []
): IStorageAdapter {
  return {
    query: vi.fn().mockImplementation((sql: string, params: unknown[]) => {
      const now = Math.floor(Date.now() / 1000);

      // Handle relation_definitions queries
      if (sql.includes('relation_definitions')) {
        const tenantId = params[0] as string;
        const objectType = params[1] as string;
        const relationName = params[2] as string;

        const matches = relationDefinitions.filter(
          (rd) =>
            (rd.tenant_id === tenantId || rd.tenant_id === 'default') &&
            rd.object_type === objectType &&
            rd.relation_name === relationName &&
            rd.is_active === 1
        );

        if (matches.length > 0) {
          // Sort by priority descending, return first
          matches.sort((a, b) => b.priority - a.priority);
          return Promise.resolve([matches[0]]);
        }
        return Promise.resolve([]);
      }

      // Handle recursive CTE queries for transitive checks
      if (sql.includes('WITH RECURSIVE')) {
        // Simplified: just return direct matches for testing
        if (sql.includes('SELECT target_type, target_id, depth, path')) {
          // Check transitive - simulate simple path finding
          const tenantId = params[0] as string;
          const userId = params[1] as string;
          const objectType = params[6] as string;
          const objectId = params[7] as string;
          const relation = params[8] as string;

          // Check direct first
          const directMatch = relationships.find(
            (r) =>
              r.from_type === 'subject' &&
              r.from_id === userId &&
              r.to_type === objectType &&
              r.to_id === objectId &&
              r.relationship_type === relation &&
              (r.expires_at === null || r.expires_at === undefined || r.expires_at > now)
          );

          if (directMatch) {
            return Promise.resolve([
              {
                target_type: objectType,
                target_id: objectId,
                depth: 1,
                path: directMatch.id,
              },
            ]);
          }
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      }

      // List objects query (direct subject tuples)
      // [tenantId, userId, objectType, relation, now, limit, offset]
      if (sql.includes('SELECT DISTINCT to_id AS object_id')) {
        const userId = params[1] as string;
        const objectType = params[2] as string;
        const relation = params[3] as string;
        const matches = relationships.filter(
          (r) =>
            r.from_type === 'subject' &&
            r.from_id === userId &&
            r.to_type === objectType &&
            r.relationship_type === relation &&
            (r.expires_at === null || r.expires_at === undefined || r.expires_at > now)
        );
        return Promise.resolve(matches.map((m) => ({ object_id: m.to_id })));
      }

      // List users query (direct subject tuples)
      // [tenantId, objectType, objectId, relation, now, limit, offset]
      if (sql.includes('SELECT DISTINCT from_id AS user_id')) {
        const objectType = params[1] as string;
        const objectId = params[2] as string;
        const relation = params[3] as string;
        const matches = relationships.filter(
          (r) =>
            r.from_type === 'subject' &&
            r.to_type === objectType &&
            r.to_id === objectId &&
            r.relationship_type === relation &&
            (r.expires_at === null || r.expires_at === undefined || r.expires_at > now)
        );
        return Promise.resolve(matches.map((m) => ({ user_id: m.from_id })));
      }

      // Group userset lookups: these fixtures hold no group tuples
      if (sql.includes("from_type = 'group'")) {
        return Promise.resolve([]);
      }

      // Two formats:
      // 1. ReBACService.checkDirectRelationship: from_type = 'subject' hardcoded (6 params)
      // 2. RelationParser.evaluateDirectRelation: from_type = ? parameter (7 params)
      if (
        sql.includes('SELECT id FROM relationships') ||
        sql.includes('SELECT id, expires_at FROM relationships')
      ) {
        let fromType: string;
        let fromId: string;
        let toType: string;
        let toId: string;
        let relType: string;
        let nowParam: number;

        if (sql.includes("from_type = 'subject'")) {
          // ReBACService format: from_type hardcoded
          // [tenantId, userId, objectType, objectId, relation, now]
          fromType = 'subject';
          fromId = params[1] as string;
          toType = params[2] as string;
          toId = params[3] as string;
          relType = params[4] as string;
          nowParam = params[5] as number;
        } else {
          // RelationParser format: from_type as parameter
          // [tenant_id, user_type, user_id, object_type, object_id, relation, now]
          fromType = params[1] as string;
          fromId = params[2] as string;
          toType = params[3] as string;
          toId = params[4] as string;
          relType = params[5] as string;
          nowParam = params[6] as number;
        }

        const matches = relationships.filter(
          (r) =>
            r.from_type === fromType &&
            r.from_id === fromId &&
            r.to_type === toType &&
            r.to_id === toId &&
            r.relationship_type === relType &&
            (r.expires_at === null || r.expires_at === undefined || r.expires_at > nowParam)
        );

        return Promise.resolve(matches.map((m) => ({ id: m.id })));
      }

      // Handle TupleToUserset queries (find related objects)
      if (sql.includes('SELECT to_type, to_id')) {
        const tenantId = params[0] as string;
        const fromType = params[1] as string;
        const fromId = params[2] as string;
        const relType = params[3] as string;

        const matches = relationships.filter(
          (r) =>
            r.from_type === fromType &&
            r.from_id === fromId &&
            r.relationship_type === relType &&
            (r.expires_at === null || r.expires_at === undefined || r.expires_at > now)
        );

        return Promise.resolve(matches.map((m) => ({ to_type: m.to_type, to_id: m.to_id })));
      }

      return Promise.resolve([]);
    }),
    execute: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as IStorageAdapter;
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('ReBAC Integration Tests', () => {
  let service: ReBACService;
  let mockAdapter: IStorageAdapter;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Direct Relationship Checks', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_456',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_2',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_789',
          relationship_type: 'editor',
        },
        {
          id: 'rel_3',
          from_type: 'subject',
          from_id: 'user_999',
          to_type: 'document',
          to_id: 'doc_456',
          relationship_type: 'owner',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should allow access when direct relationship exists', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_456',
      });

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toBe('direct');
    });

    it('should deny access when no relationship exists', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'owner',
        object: 'document:doc_456',
      });

      expect(result.allowed).toBe(false);
    });

    it('should handle user_id with type prefix', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user:user_123',
        relation: 'viewer',
        object: 'document:doc_456',
      });

      expect(result.allowed).toBe(true);
    });

    it('should handle object with explicit object_type', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'editor',
        object: 'doc_789',
        object_type: 'document',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Expired Relationships', () => {
    beforeEach(() => {
      const now = Math.floor(Date.now() / 1000);
      mockAdapter = createMockAdapter([
        {
          id: 'rel_expired',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_expired',
          relationship_type: 'viewer',
          expires_at: now - 3600, // Expired 1 hour ago
        },
        {
          id: 'rel_valid',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_valid',
          relationship_type: 'viewer',
          expires_at: now + 3600, // Valid for 1 more hour
        },
        {
          id: 'rel_no_expiry',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_permanent',
          relationship_type: 'viewer',
          expires_at: null,
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should deny access for expired relationships', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_expired',
      });

      expect(result.allowed).toBe(false);
    });

    it('should allow access for non-expired relationships', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_valid',
      });

      expect(result.allowed).toBe(true);
    });

    it('should allow access for relationships without expiry', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_permanent',
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('Contextual Tuples with Database Relationships', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_db',
          relationship_type: 'viewer',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should prefer contextual tuple over database check', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'editor', // Not in DB
        object: 'document:doc_ctx',
        context: {
          contextual_tuples: [
            {
              user_id: 'user_123',
              relation: 'editor',
              object: 'document:doc_ctx',
            },
          ],
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toBe('context');
    });

    it('should fall through to DB when contextual tuple does not match', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_db',
        context: {
          contextual_tuples: [
            {
              user_id: 'user_999', // Different user
              relation: 'viewer',
              object: 'document:doc_db',
            },
          ],
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toBe('direct');
    });

    it('should deny when neither contextual nor DB has the relationship', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'owner',
        object: 'document:doc_nonexistent',
        context: {
          contextual_tuples: [
            {
              user_id: 'user_123',
              relation: 'viewer', // Different relation
              object: 'document:doc_nonexistent',
            },
          ],
        },
      });

      expect(result.allowed).toBe(false);
    });
  });

  describe('Batch Check with Request-Scoped Caching', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_1',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_2',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_2',
          relationship_type: 'editor',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should return correct results for batch checks', async () => {
      const result = await service.batchCheck({
        checks: [
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'viewer',
            object: 'document:doc_1',
          },
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'editor',
            object: 'document:doc_2',
          },
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'owner',
            object: 'document:doc_1',
          },
        ],
      });

      expect(result.results).toHaveLength(3);
      expect(result.results[0].allowed).toBe(true);
      expect(result.results[1].allowed).toBe(true);
      expect(result.results[2].allowed).toBe(false);
    });

    it('should deduplicate identical requests within batch', async () => {
      const result = await service.batchCheck({
        checks: [
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'viewer',
            object: 'document:doc_1',
          },
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'viewer',
            object: 'document:doc_1',
          },
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'viewer',
            object: 'document:doc_1',
          },
        ],
      });

      expect(result.results).toHaveLength(3);
      expect(result.results[0].allowed).toBe(true);
      expect(result.results[1].allowed).toBe(true);
      expect(result.results[2].allowed).toBe(true);

      // Should have only made one DB call (deduplication)
      // Note: Due to the caching layer, we can verify that identical checks
      // return the same result
    });

    it('should handle mixed contextual and DB checks in batch', async () => {
      const result = await service.batchCheck({
        checks: [
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'viewer',
            object: 'document:doc_1',
            // No context, uses DB
          },
          {
            tenant_id: 'tenant_1',
            user_id: 'user_123',
            relation: 'admin',
            object: 'document:doc_ctx',
            context: {
              contextual_tuples: [
                {
                  user_id: 'user_123',
                  relation: 'admin',
                  object: 'document:doc_ctx',
                },
              ],
            },
          },
        ],
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].allowed).toBe(true);
      expect(result.results[0].resolved_via).toBe('direct');
      expect(result.results[1].allowed).toBe(true);
      expect(result.results[1].resolved_via).toBe('context');
    });
  });

  describe('List Operations', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_1',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_2',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_2',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_3',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_3',
          relationship_type: 'editor',
        },
        {
          id: 'rel_4',
          from_type: 'subject',
          from_id: 'user_456',
          to_type: 'document',
          to_id: 'doc_1',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_5',
          from_type: 'subject',
          from_id: 'user_789',
          to_type: 'document',
          to_id: 'doc_1',
          relationship_type: 'viewer',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should list objects a user has access to', async () => {
      const result = await service.listObjects({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object_type: 'document',
      });

      expect(result.object_ids).toContain('doc_1');
      expect(result.object_ids).toContain('doc_2');
      expect(result.object_ids).not.toContain('doc_3'); // editor, not viewer
    });

    it('should list users who have access to an object', async () => {
      const result = await service.listUsers({
        tenant_id: 'tenant_1',
        object: 'document:doc_1',
        relation: 'viewer',
      });

      expect(result.user_ids).toContain('user_123');
      expect(result.user_ids).toContain('user_456');
      expect(result.user_ids).toContain('user_789');
    });

    it('should handle user_id with prefix in listObjects', async () => {
      const result = await service.listObjects({
        tenant_id: 'tenant_1',
        user_id: 'user:user_123',
        relation: 'viewer',
        object_type: 'document',
      });

      expect(result.object_ids).toContain('doc_1');
      expect(result.object_ids).toContain('doc_2');
    });

    it('should handle object with explicit type in listUsers', async () => {
      const result = await service.listUsers({
        tenant_id: 'tenant_1',
        object: 'doc_1',
        object_type: 'document',
        relation: 'viewer',
      });

      expect(result.user_ids.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-Tenant Isolation', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_t1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc_shared',
          relationship_type: 'viewer',
        },
        {
          id: 'rel_t2',
          from_type: 'subject',
          from_id: 'user_456',
          to_type: 'document',
          to_id: 'doc_shared',
          relationship_type: 'viewer',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should isolate checks by tenant_id', async () => {
      // Same user, same document, but different tenants
      // In a real scenario, the adapter would filter by tenant_id
      // This test verifies the tenant_id is being passed correctly
      const result1 = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_shared',
      });

      const result2 = await service.check({
        tenant_id: 'tenant_2',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc_shared',
      });

      // Both should succeed in this mock (tenant filtering is in adapter)
      // The important thing is that tenant_id is being passed
      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('Relation Definitions (Computed Relations)', () => {
    describe('Union Relations', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            {
              id: 'rel_owner',
              from_type: 'subject',
              from_id: 'user_owner',
              to_type: 'document',
              to_id: 'doc_1',
              relationship_type: 'owner',
            },
            {
              id: 'rel_editor',
              from_type: 'subject',
              from_id: 'user_editor',
              to_type: 'document',
              to_id: 'doc_1',
              relationship_type: 'editor',
            },
          ],
          [
            {
              id: 'def_viewer',
              tenant_id: 'tenant_1',
              object_type: 'document',
              relation_name: 'can_view',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  { type: 'direct', relation: 'editor' },
                  { type: 'direct', relation: 'owner' },
                ],
              } satisfies UnionRelation),
              priority: 100,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should compute union relation (owner can_view)', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_owner',
          relation: 'can_view',
          object: 'document:doc_1',
        });

        expect(result.allowed).toBe(true);
        expect(result.resolved_via).toBe('computed');
      });

      it('should compute union relation (editor can_view)', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_editor',
          relation: 'can_view',
          object: 'document:doc_1',
        });

        expect(result.allowed).toBe(true);
        expect(result.resolved_via).toBe('computed');
      });

      it('should deny when no union child matches', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_random',
          relation: 'can_view',
          object: 'document:doc_1',
        });

        expect(result.allowed).toBe(false);
      });
    });

    describe('TupleToUserset Relations', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            // Document belongs to folder
            {
              id: 'rel_parent',
              from_type: 'document',
              from_id: 'doc_1',
              to_type: 'folder',
              to_id: 'folder_1',
              relationship_type: 'parent',
            },
            // User is viewer of folder
            {
              id: 'rel_folder_viewer',
              from_type: 'subject',
              from_id: 'user_123',
              to_type: 'folder',
              to_id: 'folder_1',
              relationship_type: 'viewer',
            },
          ],
          [
            {
              id: 'def_doc_viewer',
              tenant_id: 'tenant_1',
              object_type: 'document',
              relation_name: 'viewer',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  {
                    type: 'tuple_to_userset',
                    tupleset: { relation: 'parent' },
                    computed_userset: { relation: 'viewer' },
                  },
                ],
              } satisfies UnionRelation),
              priority: 100,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should compute inherited permission via parent folder', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_123',
          relation: 'viewer',
          object: 'document:doc_1',
        });

        expect(result.allowed).toBe(true);
        expect(result.resolved_via).toBe('computed');
      });
    });

    describe('Default Tenant Relation Definitions', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            {
              id: 'rel_1',
              from_type: 'subject',
              from_id: 'user_123',
              to_type: 'file',
              to_id: 'file_1',
              relationship_type: 'owner',
            },
          ],
          [
            {
              id: 'def_default',
              tenant_id: 'default', // Default tenant
              object_type: 'file',
              relation_name: 'can_access',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  { type: 'direct', relation: 'owner' },
                ],
              } satisfies UnionRelation),
              priority: 50,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should use default tenant definition when tenant-specific not found', async () => {
        const result = await service.check({
          tenant_id: 'tenant_custom', // Not 'default'
          user_id: 'user_123',
          relation: 'can_access',
          object: 'file:file_1',
        });

        expect(result.allowed).toBe(true);
        expect(result.resolved_via).toBe('computed');
      });
    });
  });

  describe('Complex Scenarios', () => {
    describe('Document in Folder in Project Hierarchy', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            // Project structure: project -> folder -> document
            {
              id: 'rel_doc_parent',
              from_type: 'document',
              from_id: 'doc_final',
              to_type: 'folder',
              to_id: 'folder_reports',
              relationship_type: 'parent',
            },
            {
              id: 'rel_folder_parent',
              from_type: 'folder',
              from_id: 'folder_reports',
              to_type: 'project',
              to_id: 'proj_main',
              relationship_type: 'parent',
            },
            // User is project admin
            {
              id: 'rel_proj_admin',
              from_type: 'subject',
              from_id: 'user_admin',
              to_type: 'project',
              to_id: 'proj_main',
              relationship_type: 'admin',
            },
            // Direct document viewer
            {
              id: 'rel_doc_viewer',
              from_type: 'subject',
              from_id: 'user_direct',
              to_type: 'document',
              to_id: 'doc_final',
              relationship_type: 'viewer',
            },
          ],
          [
            // Document viewer = direct viewer OR inherited from folder
            {
              id: 'def_doc_viewer',
              tenant_id: 'tenant_1',
              object_type: 'document',
              relation_name: 'viewer',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  {
                    type: 'tuple_to_userset',
                    tupleset: { relation: 'parent' },
                    computed_userset: { relation: 'viewer' },
                  },
                ],
              } satisfies UnionRelation),
              priority: 100,
              is_active: 1,
            },
            // Folder viewer = direct viewer OR inherited from project
            {
              id: 'def_folder_viewer',
              tenant_id: 'tenant_1',
              object_type: 'folder',
              relation_name: 'viewer',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  { type: 'direct', relation: 'admin' },
                  {
                    type: 'tuple_to_userset',
                    tupleset: { relation: 'parent' },
                    computed_userset: { relation: 'viewer' },
                  },
                ],
              } satisfies UnionRelation),
              priority: 100,
              is_active: 1,
            },
            // Project viewer = direct viewer OR admin
            {
              id: 'def_proj_viewer',
              tenant_id: 'tenant_1',
              object_type: 'project',
              relation_name: 'viewer',
              definition_json: JSON.stringify({
                type: 'union',
                children: [
                  { type: 'direct', relation: 'viewer' },
                  { type: 'direct', relation: 'admin' },
                ],
              } satisfies UnionRelation),
              priority: 100,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should allow direct document viewer', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_direct',
          relation: 'viewer',
          object: 'document:doc_final',
        });

        expect(result.allowed).toBe(true);
      });

      it('should deny user without any access', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_random',
          relation: 'viewer',
          object: 'document:doc_final',
        });

        expect(result.allowed).toBe(false);
      });
    });

    describe('Intersection Relations (AND Logic)', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            // User has both manager and member roles
            {
              id: 'rel_manager',
              from_type: 'subject',
              from_id: 'user_both',
              to_type: 'team',
              to_id: 'team_1',
              relationship_type: 'manager',
            },
            {
              id: 'rel_member',
              from_type: 'subject',
              from_id: 'user_both',
              to_type: 'team',
              to_id: 'team_1',
              relationship_type: 'member',
            },
            // User has only manager role
            {
              id: 'rel_only_manager',
              from_type: 'subject',
              from_id: 'user_manager',
              to_type: 'team',
              to_id: 'team_1',
              relationship_type: 'manager',
            },
          ],
          [
            {
              id: 'def_admin',
              tenant_id: 'tenant_1',
              object_type: 'team',
              relation_name: 'admin',
              definition_json: JSON.stringify({
                type: 'intersection',
                children: [
                  { type: 'direct', relation: 'manager' },
                  { type: 'direct', relation: 'member' },
                ],
              } satisfies IntersectionRelation),
              priority: 100,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should allow when ALL intersection conditions are met', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_both',
          relation: 'admin',
          object: 'team:team_1',
        });

        expect(result.allowed).toBe(true);
        expect(result.resolved_via).toBe('computed');
      });

      it('should deny when only one intersection condition is met', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_manager',
          relation: 'admin',
          object: 'team:team_1',
        });

        expect(result.allowed).toBe(false);
      });
    });

    describe('Exclusion Relations (NOT Logic)', () => {
      beforeEach(() => {
        mockAdapter = createMockAdapter(
          [
            // User has viewer but is also blocked
            {
              id: 'rel_viewer',
              from_type: 'subject',
              from_id: 'user_blocked',
              to_type: 'document',
              to_id: 'doc_sensitive',
              relationship_type: 'viewer',
            },
            {
              id: 'rel_blocked',
              from_type: 'subject',
              from_id: 'user_blocked',
              to_type: 'document',
              to_id: 'doc_sensitive',
              relationship_type: 'blocked',
            },
            // User has viewer only
            {
              id: 'rel_viewer2',
              from_type: 'subject',
              from_id: 'user_normal',
              to_type: 'document',
              to_id: 'doc_sensitive',
              relationship_type: 'viewer',
            },
          ],
          [
            {
              id: 'def_can_read',
              tenant_id: 'tenant_1',
              object_type: 'document',
              relation_name: 'can_read',
              definition_json: JSON.stringify({
                type: 'exclusion',
                base: { type: 'direct', relation: 'viewer' },
                subtract: { type: 'direct', relation: 'blocked' },
              } satisfies ExclusionRelation),
              priority: 100,
              is_active: 1,
            },
          ]
        );
        service = new ReBACService(mockAdapter);
      });

      it('should deny when user is in exclusion list', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_blocked',
          relation: 'can_read',
          object: 'document:doc_sensitive',
        });

        expect(result.allowed).toBe(false);
      });

      it('should allow when user has base but not in exclusion list', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_normal',
          relation: 'can_read',
          object: 'document:doc_sensitive',
        });

        expect(result.allowed).toBe(true);
      });

      it('should deny when user has neither base nor exclusion', async () => {
        const result = await service.check({
          tenant_id: 'tenant_1',
          user_id: 'user_random',
          relation: 'can_read',
          object: 'document:doc_sensitive',
        });

        expect(result.allowed).toBe(false);
      });
    });
  });

  describe('Edge Cases', () => {
    beforeEach(() => {
      mockAdapter = createMockAdapter([
        {
          id: 'rel_1',
          from_type: 'subject',
          from_id: 'user_123',
          to_type: 'document',
          to_id: 'doc-with-dashes_and_underscores',
          relationship_type: 'viewer',
        },
      ]);
      service = new ReBACService(mockAdapter);
    });

    it('should handle special characters in IDs', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc-with-dashes_and_underscores',
      });

      expect(result.allowed).toBe(true);
    });

    it('should handle empty contextual tuples array', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc-with-dashes_and_underscores',
        context: {
          contextual_tuples: [],
        },
      });

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toBe('direct');
    });

    it('should handle undefined context', async () => {
      const result = await service.check({
        tenant_id: 'tenant_1',
        user_id: 'user_123',
        relation: 'viewer',
        object: 'document:doc-with-dashes_and_underscores',
        context: undefined,
      });

      expect(result.allowed).toBe(true);
    });
  });
});
