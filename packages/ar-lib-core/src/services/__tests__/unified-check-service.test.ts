/**
 * Unified Check Service Unit Tests
 *
 * Phase 8.3: Real-time Check API Model
 *
 * Tests for:
 * - Permission parsing (string and object formats)
 * - UnifiedCheckService evaluation
 * - Cache behavior
 * - Batch check operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parsePermission,
  formatPermission,
  createUnifiedCheckService,
  UnifiedCheckService,
} from '../unified-check-service';
import type { CheckApiRequest, ParsedPermission } from '../../types/check-api';

// Mock D1 database: `all` and `first` are given the statement's SQL
const mockD1 = {
  prepare: vi.fn((sql: string) => {
    const statement = {
      bind: () => statement,
      all: () => mockD1.all(sql),
      first: () => mockD1.first(sql),
    };
    return statement;
  }),
  all: vi.fn(),
  first: vi.fn(),
};

/**
 * The subject's roles, read as the service reads them: its assignments (account database), then
 * the roles they name (metadata database). Other statements find nothing.
 */
function mockSubjectRoles(
  roles: Array<{
    name: string;
    permissions_json: string;
    scope_type?: string;
    scope_target?: string;
  }>
) {
  mockD1.all.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM role_assignments')) {
      return {
        results: roles.map((role, index) => ({
          id: `ra_${index}`,
          role_id: `role_${index}`,
          scope_type: role.scope_type ?? 'global',
          scope_target: role.scope_target ?? '',
          expires_at: null,
          assigned_by: null,
          created_at: 0,
        })),
      };
    }
    if (sql.includes('FROM roles')) {
      return {
        results: roles.map(({ name, permissions_json }, index) => ({
          id: `role_${index}`,
          name,
          permissions_json,
        })),
      };
    }
    return { results: [] };
  });
}

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

describe('Permission Parser', () => {
  describe('parsePermission - String Format', () => {
    it('should parse type-level permission (resource:action)', () => {
      const result = parsePermission('documents:read');

      expect(result.type).toBe('type_level');
      expect(result.resource).toBe('documents');
      expect(result.action).toBe('read');
      expect(result.id).toBeUndefined();
      expect(result.original).toBe('documents:read');
    });

    it('should parse ID-level permission (resource:id:action)', () => {
      const result = parsePermission('documents:doc_123:read');

      expect(result.type).toBe('id_level');
      expect(result.resource).toBe('documents');
      expect(result.id).toBe('doc_123');
      expect(result.action).toBe('read');
      expect(result.original).toBe('documents:doc_123:read');
    });

    it('should accept URL-safe characters in components', () => {
      const result = parsePermission('my-resource:item_123-abc:read_write');

      expect(result.type).toBe('id_level');
      expect(result.resource).toBe('my-resource');
      expect(result.id).toBe('item_123-abc');
      expect(result.action).toBe('read_write');
    });

    it('should reject permission with too few colons', () => {
      expect(() => parsePermission('documents')).toThrow(/Invalid permission format/);
    });

    it('should reject permission with too many colons', () => {
      expect(() => parsePermission('a:b:c:d')).toThrow(/Invalid permission format/);
    });

    it('should reject empty resource', () => {
      expect(() => parsePermission(':read')).toThrow(/resource cannot be empty/);
    });

    it('should reject empty action', () => {
      expect(() => parsePermission('documents:')).toThrow(/action cannot be empty/);
    });

    it('should reject empty ID in ID-level permission', () => {
      expect(() => parsePermission('documents::read')).toThrow(/id cannot be empty/);
    });

    it('should reject non-URL-safe characters in resource', () => {
      expect(() => parsePermission('docu ments:read')).toThrow(/must be URL-safe/);
    });

    it('should parse ambiguous colon as ID-level permission', () => {
      // 'doc:uments:read' is parsed as resource=doc, id=uments, action=read
      const result = parsePermission('doc:uments:read');
      expect(result.type).toBe('id_level');
      expect(result.resource).toBe('doc');
      expect(result.id).toBe('uments');
      expect(result.action).toBe('read');
    });
  });

  describe('parsePermission - Object Format', () => {
    it('should parse type-level permission object', () => {
      const result = parsePermission({
        resource: 'documents',
        action: 'read',
      });

      expect(result.type).toBe('type_level');
      expect(result.resource).toBe('documents');
      expect(result.action).toBe('read');
      expect(result.id).toBeUndefined();
    });

    it('should parse ID-level permission object', () => {
      const result = parsePermission({
        resource: 'documents',
        id: 'doc_123',
        action: 'read',
      });

      expect(result.type).toBe('id_level');
      expect(result.resource).toBe('documents');
      expect(result.id).toBe('doc_123');
      expect(result.action).toBe('read');
    });

    it('should treat empty id as type-level', () => {
      const result = parsePermission({
        resource: 'documents',
        id: '',
        action: 'read',
      });

      expect(result.type).toBe('type_level');
      expect(result.id).toBeUndefined();
    });

    it('should reject empty resource in object', () => {
      expect(() =>
        parsePermission({
          resource: '',
          action: 'read',
        })
      ).toThrow(/resource cannot be empty/);
    });

    it('should reject empty action in object', () => {
      expect(() =>
        parsePermission({
          resource: 'documents',
          action: '',
        })
      ).toThrow(/action cannot be empty/);
    });

    it('should reject non-URL-safe resource in object', () => {
      expect(() =>
        parsePermission({
          resource: 'docu ments',
          action: 'read',
        })
      ).toThrow(/must be URL-safe/);
    });
  });

  describe('parsePermission - Invalid Input Types', () => {
    it('should reject null input', () => {
      expect(() => parsePermission(null as unknown as string)).toThrow();
    });

    it('should reject number input', () => {
      expect(() => parsePermission(123 as unknown as string)).toThrow(
        /Invalid permission input type/
      );
    });

    it('should reject array input', () => {
      expect(() => parsePermission(['documents', 'read'] as unknown as string)).toThrow();
    });
  });

  describe('formatPermission', () => {
    it('should format type-level permission', () => {
      const parsed: ParsedPermission = {
        type: 'type_level',
        resource: 'documents',
        action: 'read',
        original: 'documents:read',
      };

      expect(formatPermission(parsed)).toBe('documents:read');
    });

    it('should format ID-level permission', () => {
      const parsed: ParsedPermission = {
        type: 'id_level',
        resource: 'documents',
        id: 'doc_123',
        action: 'read',
        original: 'documents:doc_123:read',
      };

      expect(formatPermission(parsed)).toBe('documents:doc_123:read');
    });
  });
});

describe('UnifiedCheckService', () => {
  let service: UnifiedCheckService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1.all.mockResolvedValue({ results: [] });
    mockD1.first.mockResolvedValue(null);
    mockKV.get.mockResolvedValue(null);

    service = createUnifiedCheckService({
      db: mockD1 as unknown as D1Database,
      cache: mockKV as unknown as KVNamespace,
      cacheTTL: 60,
      debugMode: false,
    });
  });

  describe('check - Basic Operations', () => {
    it('should deny when no matching permissions exist', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(false);
      expect(result.final_decision).toBe('deny');
      expect(result.reason).toBe('no_matching_permission');
    });

    it('should return evaluation error for invalid permission format', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'invalid',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(false);
      expect(result.final_decision).toBe('deny');
      expect(result.reason).toContain('evaluation_error');
    });

    it('ignores a previously cached allow', async () => {
      const cachedResponse = {
        allowed: true,
        resolved_via: ['role'],
        final_decision: 'allow',
        cache_ttl: 60,
      };
      mockKV.get.mockResolvedValue(JSON.stringify(cachedResponse));

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(false);
      expect(result.cache_ttl).toBe(0);
      expect(mockD1.prepare).toHaveBeenCalled();
    });

    it('does not share decisions after evaluation', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      };

      await service.check(request);

      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('does not let resource context poison the cache for a later request', async () => {
      const cached = new Map<string, string>();
      const cache = {
        get: vi.fn(async (key: string) => cached.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          cached.set(key, value);
        }),
      };
      const cacheService = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        cache: cache as unknown as KVNamespace,
      });

      const allowed = await cacheService.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        resource_context: { owner_id: 'user_123' },
      });
      const denied = await cacheService.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        resource_context: { owner_id: 'other_user' },
      });

      expect(allowed.allowed).toBe(true);
      expect(allowed.cache_ttl).toBe(0);
      expect(denied.allowed).toBe(false);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('does not let contextual ReBAC tuples poison a later relationship check', async () => {
      const cached = new Map<string, string>();
      const cache = {
        get: vi.fn(async (key: string) => cached.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          cached.set(key, value);
        }),
      };
      const rebacService = {
        check: vi.fn(async (request: { context?: { contextual_tuples?: unknown[] } }) => ({
          allowed: Boolean(request.context?.contextual_tuples?.length),
        })),
      };
      const cacheService = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        cache: cache as unknown as KVNamespace,
        rebacService: rebacService as never,
        enableRebac: true,
      });

      const allowed = await cacheService.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        rebac: {
          relation: 'viewer',
          object: 'document:secret',
          contextual_tuples: [
            { user_id: 'user_123', relation: 'viewer', object: 'document:secret' },
          ],
        },
      });
      const denied = await cacheService.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        rebac: { relation: 'viewer', object: 'document:secret' },
      });

      expect(allowed.allowed).toBe(true);
      expect(allowed.cache_ttl).toBe(0);
      expect(denied.allowed).toBe(false);
      expect(rebacService.check).toHaveBeenCalledTimes(2);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });
  });

  describe('check - Role-Based Permission (RBAC)', () => {
    it('should allow when user has matching role permission', async () => {
      // Mock role with permission
      mockSubjectRoles([
        {
          name: 'admin',
          permissions_json: JSON.stringify(['documents:read', 'documents:write']),
        },
      ]);

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toContain('role');
    });

    it('should allow when role has wildcard permission', async () => {
      mockSubjectRoles([
        {
          name: 'admin',
          permissions_json: JSON.stringify(['documents:*']),
        },
      ]);

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:delete',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toContain('role');
    });

    it('should allow when role has global wildcard', async () => {
      mockSubjectRoles([
        {
          name: 'super_admin',
          permissions_json: JSON.stringify(['*:*']),
        },
      ]);

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'anything:read',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(true);
    });

    it('grants a scoped role only where it is assigned', async () => {
      mockSubjectRoles([
        {
          name: 'group_editor',
          permissions_json: JSON.stringify(['documents:read']),
          scope_type: 'group',
          scope_target: 'group:grp_a',
        },
        {
          // The organisation scope is gone: an assignment still naming it grants nothing.
          name: 'org_editor',
          permissions_json: JSON.stringify(['documents:read']),
          scope_type: 'org',
          scope_target: 'org:org_a',
        },
        {
          name: 'doc_owner',
          permissions_json: JSON.stringify(['reports:*']),
          scope_type: 'resource',
          scope_target: 'resource:reports:rep_1',
        },
      ]);
      const check = (permission: string, groupId?: string) =>
        service.check({
          subject_id: 'user_123',
          permission,
          tenant_id: 'default',
          ...(groupId ? { resource_context: { group_id: groupId } } : {}),
        });

      expect((await check('documents:read', 'grp_a')).resolved_via).toContain('role');
      expect((await check('documents:read', 'grp_b')).allowed).toBe(false);
      expect((await check('documents:read', 'org_a')).allowed).toBe(false);
      expect((await check('documents:read')).allowed).toBe(false);
      expect((await check('reports:rep_1:write')).resolved_via).toContain('role');
      expect((await check('reports:rep_2:write')).allowed).toBe(false);
      expect((await check('reports:write')).allowed).toBe(false);
    });

    it('grants nothing from a role with an empty or unknown scope', async () => {
      mockSubjectRoles([
        { name: 'blank', permissions_json: JSON.stringify(['reports:*']), scope_type: '' },
        { name: 'odd', permissions_json: JSON.stringify(['reports:*']), scope_type: 'region' },
      ]);

      const result = await service.check({
        subject_id: 'user_123',
        permission: 'reports:read',
        tenant_id: 'default',
      });

      expect(result.allowed).toBe(false);
    });

    it('grants a tenant-scoped role (as invitations once gave) in its own tenant', async () => {
      mockSubjectRoles([
        {
          name: 'member',
          permissions_json: JSON.stringify(['documents:read']),
          scope_type: 'tenant',
          scope_target: 'default',
        },
        {
          name: 'elsewhere',
          permissions_json: JSON.stringify(['documents:write']),
          scope_type: 'tenant',
          scope_target: 'other_tenant',
        },
      ]);
      const check = (permission: string) =>
        service.check({ subject_id: 'user_123', permission, tenant_id: 'default' });

      expect((await check('documents:read')).allowed).toBe(true);
      expect((await check('documents:write')).allowed).toBe(false);
    });

    it("reads the subject's assignments from its account database", async () => {
      // The metadata database (mockD1) defines the role and holds no assignment of it.
      mockSubjectRoles([]);
      mockD1.all.mockImplementation(async (sql: string) => ({
        results: sql.includes('FROM roles')
          ? [{ id: 'role_editor', name: 'editor', permissions_json: '["documents:write"]' }]
          : [],
      }));
      const accountQueries: string[] = [];
      const account = {
        query: vi.fn(async (sql: string) => {
          accountQueries.push(sql);
          return sql.includes('FROM role_assignments')
            ? [{ id: 'ra_1', role_id: 'role_editor', scope_type: 'global', scope_target: '' }]
            : [];
        }),
        queryOne: vi.fn(async () => null),
        execute: vi.fn(),
        batch: vi.fn(),
        transaction: vi.fn(),
        isHealthy: vi.fn(),
        getType: () => 'mock',
        close: vi.fn(),
      };
      const subjectAccountDb = vi.fn(async () => account as never);
      const routed = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        subjectAccountDb,
      });

      const result = await routed.check({
        subject_id: 'user_123',
        permission: 'documents:write',
        tenant_id: 'default',
      });

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toContain('role');
      expect(subjectAccountDb).toHaveBeenCalledWith('default', 'user_123');
      expect(accountQueries.some((sql) => sql.includes('FROM roles'))).toBe(false);
    });

    it('should deny when role does not have permission', async () => {
      mockSubjectRoles([
        {
          name: 'viewer',
          permissions_json: JSON.stringify(['documents:read']),
        },
      ]);

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:delete',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(false);
    });
  });

  describe('check - Computed/ABAC Permission', () => {
    it('should allow when user is resource owner', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        resource_context: {
          owner_id: 'user_123',
        },
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toContain('computed');
    });

    it('grants nothing for membership of the resource group alone', async () => {
      // The subject's membership (account database) of an active group (metadata)
      mockD1.all.mockImplementation(async (sql: string) => ({
        results: sql.includes('FROM group_memberships')
          ? [{ group_id: 'grp_456' }]
          : sql.includes('FROM "groups"')
            ? [{ id: 'grp_456', parent_group_id: null, lifecycle_state: 'active' }]
            : [],
      }));

      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
        resource_context: {
          group_id: 'grp_456',
        },
      };

      const result = await service.check(request);

      expect(result.allowed).toBe(false);
      expect(result.resolved_via).not.toContain('computed');
    });
  });

  describe("check - the tenant's attribute-based policy", () => {
    const allowPremium = {
      evaluate: vi.fn((context: { verifiedAttributes: Array<{ name: string; value: string }> }) => {
        const premium = context.verifiedAttributes.some(
          (attribute) => attribute.name === 'tier' && attribute.value === 'premium'
        );
        return premium
          ? { allowed: true, reason: 'premium', decidedBy: 'rule_premium' }
          : { allowed: false, reason: 'no rule matched' };
      }),
    };
    const attributes = {
      getValidAttributesForUser: vi.fn(async () => ({ tier: 'premium' })),
    };
    const request: CheckApiRequest = {
      subject_id: 'user_123',
      permission: 'reports:read',
      tenant_id: 'acme',
    };

    it('grants through the tenant rules with its verified attributes when both are on', async () => {
      const abacService = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: async () => ({
          abac: true,
          verifiedAttributes: true,
          logDecisions: false,
          evaluator: allowPremium,
        }),
      });

      const result = await abacService.check(request);

      expect(result.allowed).toBe(true);
      expect(result.resolved_via).toContain('computed');
      expect(attributes.getValidAttributesForUser).toHaveBeenCalledWith('acme', 'user_123');
    });

    it('does not load verified attributes, or evaluate rules, when the settings keep them off', async () => {
      const withoutAttributes = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: async () => ({
          abac: true,
          verifiedAttributes: false,
          logDecisions: false,
          evaluator: allowPremium,
        }),
      });
      expect((await withoutAttributes.check(request)).allowed).toBe(false);
      expect(attributes.getValidAttributesForUser).not.toHaveBeenCalled();
      allowPremium.evaluate.mockClear();

      const abacOff = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: async () => ({
          abac: false,
          verifiedAttributes: true,
          logDecisions: false,
          evaluator: allowPremium,
        }),
      });
      expect((await abacOff.check(request)).allowed).toBe(false);
      expect(allowPremium.evaluate).not.toHaveBeenCalled();
    });

    it('turns attribute-based policy off when the tenant settings cannot be resolved', async () => {
      const failing = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: async () => {
          throw new Error('settings unavailable');
        },
      });
      expect((await failing.check(request)).allowed).toBe(false);
    });

    it('grants nothing through the rules when attributes or roles cannot be read', async () => {
      // A rule set that would grant: without the subject's attributes or roles, a rule denying
      // on one of them could be skipped, so the rules are not evaluated at all.
      const grantAll = { evaluate: vi.fn(() => ({ allowed: true, decidedBy: 'rule_any' })) };
      const policy = async () => ({
        abac: true,
        verifiedAttributes: true,
        logDecisions: false,
        evaluator: grantAll,
      });

      const attributesDown = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: {
          getValidAttributesForUser: vi.fn(async () => {
            throw new Error('attributes unavailable');
          }),
        },
        tenantPolicy: policy,
      });
      expect((await attributesDown.check(request)).allowed).toBe(false);

      mockD1.all.mockRejectedValueOnce(new Error('roles unavailable'));
      const rolesDown = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: policy,
      });
      expect((await rolesDown.check(request)).allowed).toBe(false);
      expect(grantAll.evaluate).not.toHaveBeenCalled();

      // With both read, the same rules grant.
      const healthy = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy: policy,
      });
      expect((await healthy.check(request)).allowed).toBe(true);
    });

    it("gives the rules the subject's effective groups (direct and ancestors)", async () => {
      mockD1.all.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM group_memberships')) return { results: [{ group_id: 'grp_team' }] };
        if (sql.includes('FROM "groups"')) {
          return {
            results: [
              { id: 'grp_team', parent_group_id: 'grp_dept', lifecycle_state: 'active' },
              { id: 'grp_dept', parent_group_id: null, lifecycle_state: 'active' },
            ],
          };
        }
        return { results: [] };
      });
      const inDept = {
        usesSubjectGroups: true,
        evaluate: vi.fn((context: { subjectGroupIds?: string[] }) =>
          context.subjectGroupIds?.includes('grp_dept')
            ? { allowed: true, decidedBy: 'rule_dept' }
            : { allowed: false }
        ),
      };
      const withGroups = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        tenantPolicy: async () => ({
          abac: true,
          verifiedAttributes: false,
          logDecisions: false,
          evaluator: inDept,
        }),
      });

      expect((await withGroups.check(request)).allowed).toBe(true);
      const [evaluated] = inDept.evaluate.mock.calls[0] ?? [];
      expect([...(evaluated?.subjectGroupIds ?? [])].sort()).toEqual(['grp_dept', 'grp_team']);
    });

    it('does not evaluate rules with group conditions when the groups cannot be read', async () => {
      mockD1.all.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM group_memberships')) throw new Error('memberships unavailable');
        return { results: [] };
      });
      const grantAll = {
        usesSubjectGroups: true,
        evaluate: vi.fn(() => ({ allowed: true, decidedBy: 'rule_any' })),
      };
      const groupsDown = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        tenantPolicy: async () => ({
          abac: true,
          verifiedAttributes: false,
          logDecisions: false,
          evaluator: grantAll,
        }),
      });

      expect((await groupsDown.check(request)).allowed).toBe(false);
      expect(grantAll.evaluate).not.toHaveBeenCalled();
    });

    it('evaluates no rule while memberships are unknown, and still grants through known roles', async () => {
      // A dynamic row whose publication cannot be checked (the catalog read fails), next to a
      // direct role assignment.
      mockD1.all.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM group_memberships')) {
          return {
            results: [
              {
                group_id: 'grp_dyn',
                assignment_source: 'dynamic',
                source_ref: '0000000000000001:1',
              },
              // The publication record (read in the same statement).
              {
                group_id: null,
                assignment_source: 'publication_record',
                source_ref: '0000000000000001:1',
              },
            ],
          };
        }
        // The unknown group carries a role grant: the roles are incomplete.
        if (sql.includes('FROM group_role_assignments')) {
          return {
            results: [
              {
                id: 'gra',
                group_id: 'grp_dyn',
                role_id: 'role_x',
                scope_type: 'global',
                scope_target: '',
                expires_at: null,
                assigned_by: null,
                created_at: 0,
              },
            ],
          };
        }
        if (sql.includes('FROM role_assignments')) {
          return {
            results: [
              {
                id: 'ra',
                role_id: 'role_0',
                scope_type: 'global',
                scope_target: '',
                expires_at: null,
                created_at: 0,
              },
            ],
          };
        }
        if (sql.includes('FROM roles')) {
          return {
            results: [{ id: 'role_0', name: 'writer', permissions_json: '["notes:write"]' }],
          };
        }
        return { results: [] };
      });
      mockD1.first.mockImplementation(async (sql: string) => {
        if (sql.includes('service_group_catalog')) throw new Error('catalog unavailable');
        return null;
      });
      const grantAll = {
        usesSubjectGroups: true,
        evaluate: vi.fn(() => ({ allowed: true, decidedBy: 'rule_any' })),
      };
      // Rules that read no group are not evaluated either: the roles through the unknown
      // memberships are unknown too, and a rule may deny on a role the subject lacks.
      const noGroupRules = { evaluate: vi.fn(() => ({ allowed: true, decidedBy: 'rule_roles' })) };
      const service = (evaluator: typeof grantAll | typeof noGroupRules) =>
        createUnifiedCheckService({
          db: mockD1 as unknown as D1Database,
          tenantPolicy: async () => ({
            abac: true,
            verifiedAttributes: false,
            logDecisions: false,
            evaluator,
          }),
        });

      expect((await service(grantAll).check(request)).allowed).toBe(false);
      expect((await service(noGroupRules).check(request)).allowed).toBe(false);
      expect(grantAll.evaluate).not.toHaveBeenCalled();
      expect(noGroupRules.evaluate).not.toHaveBeenCalled();
      // The direct role is known: it still grants what it grants.
      const direct = await service(noGroupRules).check({ ...request, permission: 'notes:write' });
      expect(direct).toMatchObject({ allowed: true, resolved_via: ['role'] });
    });

    it('denies an account:-prefixed subject on its attribute before a group allow', async () => {
      const accountDb = {
        prepare: (sql: string) => {
          const statement = {
            bind: () => statement,
            all: async () =>
              sql.includes('FROM group_memberships')
                ? { results: [{ group_id: 'grp_staff', assignment_source: 'manual' }] }
                : { results: [] },
            first: async () => null,
          };
          return statement;
        },
      };
      mockD1.all.mockImplementation(async (sql: string) =>
        sql.includes('FROM "groups"')
          ? { results: [{ id: 'grp_staff', parent_group_id: null, lifecycle_state: 'active' }] }
          : { results: [] }
      );
      // The attribute is stored under the canonical id only.
      const blockedAttributes = {
        getValidAttributesForUser: vi.fn(async (_tenant: string, subject: string) =>
          subject === 'user_123' ? { blocked: 'true' } : {}
        ),
      };
      // As a tenant's rules: deny on the attribute first, then allow members of the group.
      const rules = {
        usesSubjectGroups: true,
        evaluate: vi.fn(
          (context: {
            subjectGroupIds?: string[];
            verifiedAttributes: Array<{ name: string; value: string | null }>;
          }) =>
            context.verifiedAttributes.some((a) => a.name === 'blocked' && a.value === 'true')
              ? { allowed: false, decidedBy: 'deny_blocked' }
              : context.subjectGroupIds?.includes('grp_staff')
                ? { allowed: true, decidedBy: 'allow_staff' }
                : { allowed: false }
        ),
      };
      const service = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: blockedAttributes,
        subjectAccount: async () => ({
          db: accountDb as unknown as D1Database,
          subjectId: 'user_123',
        }),
        tenantPolicy: async () => ({
          abac: true,
          verifiedAttributes: true,
          logDecisions: false,
          evaluator: rules,
        }),
      });

      const result = await service.check({ ...request, subject_id: 'account:user_123' });
      expect(result.allowed).toBe(false);
      expect(blockedAttributes.getValidAttributesForUser).toHaveBeenCalledWith('acme', 'user_123');
      expect(rules.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({ subjectId: 'user_123' })
      );
    });

    it("reads the subject's rows under the account router's canonical id", async () => {
      const binds: Array<{ sql: string; params: unknown[] }> = [];
      const accountDb = {
        prepare: (sql: string) => {
          const statement = {
            bind: (...params: unknown[]) => {
              binds.push({ sql, params });
              return statement;
            },
            all: async () =>
              sql.includes('FROM role_assignments')
                ? {
                    results: [
                      {
                        id: 'ra',
                        role_id: 'role_0',
                        scope_type: 'global',
                        scope_target: '',
                        expires_at: null,
                        created_at: 0,
                      },
                    ],
                  }
                : { results: [] },
            first: async () => null,
          };
          return statement;
        },
      };
      mockSubjectRoles([{ name: 'reader', permissions_json: '["reports:read"]' }]);
      const subjectAccount = vi.fn(async () => ({
        db: accountDb as unknown as D1Database,
        subjectId: 'user_123',
      }));
      const canonical = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        subjectAccount,
      });

      const result = await canonical.check({ ...request, subject_id: ' account:user_123' });
      expect(result.allowed).toBe(true);
      expect(subjectAccount).toHaveBeenCalledWith('acme', ' account:user_123');
      const reads = binds.filter(
        ({ sql }) => sql.includes('FROM role_assignments') || sql.includes('FROM group_memberships')
      );
      expect(reads.length).toBeGreaterThan(0);
      for (const { params } of reads) {
        expect(params).toContain('user_123');
        expect(params).not.toContain(' account:user_123');
      }
    });

    it('keeps results out of the shared cache while tenant rules apply or cannot be read', async () => {
      const cache = { get: vi.fn(async () => null), put: vi.fn(async () => undefined) };
      const withPolicy = (policy: Record<string, unknown>) =>
        createUnifiedCheckService({
          db: mockD1 as unknown as D1Database,
          cache: cache as unknown as KVNamespace,
          attributeRepository: attributes,
          tenantPolicy: async () => ({
            abac: false,
            verifiedAttributes: false,
            logDecisions: false,
            ...policy,
          }),
        });

      await withPolicy({ abac: true, verifiedAttributes: true, evaluator: allowPremium }).check(
        request
      );
      await withPolicy({ unavailable: true }).check(request);
      await createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        cache: cache as unknown as KVNamespace,
        tenantPolicy: async () => {
          throw new Error('settings unavailable');
        },
      }).check(request);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();

      // Decisions without tenant rules use the same authoritative read.
      await withPolicy({}).check(request);
      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('resolves the settings of each check tenant once', async () => {
      const tenantPolicy = vi.fn(async (tenantId: string) => ({
        abac: tenantId === 'acme',
        verifiedAttributes: true,
        logDecisions: false,
        evaluator: allowPremium,
      }));
      const perTenant = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        attributeRepository: attributes,
        tenantPolicy,
      });

      const result = await perTenant.batchCheck({
        checks: [request, { ...request, tenant_id: 'other' }, request],
      });

      expect(result.results.map((entry) => entry.allowed)).toEqual([true, false, true]);
      expect(tenantPolicy).toHaveBeenCalledTimes(2);
    });
  });

  describe('batchCheck', () => {
    it('should process multiple checks and return summary', async () => {
      // A role granting the first check's permission only
      mockSubjectRoles([{ name: 'admin', permissions_json: JSON.stringify(['documents:read']) }]);

      const result = await service.batchCheck({
        checks: [
          { subject_id: 'user_123', permission: 'documents:read', tenant_id: 'default' },
          { subject_id: 'user_123', permission: 'documents:delete', tenant_id: 'default' },
        ],
      });

      expect(result.results).toHaveLength(2);
      expect(result.summary.total).toBe(2);
      expect(result.summary.allowed).toBe(1);
      expect(result.summary.denied).toBe(1);
    });

    it('should stop on first deny when stop_on_deny is true', async () => {
      mockD1.all.mockResolvedValue({ results: [] }); // No permissions - will deny

      const result = await service.batchCheck({
        checks: [
          { subject_id: 'user_123', permission: 'documents:read', tenant_id: 'default' },
          { subject_id: 'user_123', permission: 'documents:write', tenant_id: 'default' },
          { subject_id: 'user_123', permission: 'documents:delete', tenant_id: 'default' },
        ],
        stop_on_deny: true,
      });

      expect(result.results).toHaveLength(3);
      expect(result.results[0].final_decision).toBe('deny');
      expect(result.results[1].reason).toBe('skipped_due_to_stop_on_deny');
      expect(result.results[2].reason).toBe('skipped_due_to_stop_on_deny');
    });

    it('should include evaluation time in summary', async () => {
      const result = await service.batchCheck({
        checks: [{ subject_id: 'user_123', permission: 'documents:read', tenant_id: 'default' }],
      });

      expect(result.summary.evaluation_time_ms).toBeDefined();
      expect(typeof result.summary.evaluation_time_ms).toBe('number');
    });
  });

  describe('Debug Mode', () => {
    it('should include debug info when debug mode is enabled', async () => {
      const debugService = createUnifiedCheckService({
        db: mockD1 as unknown as D1Database,
        debugMode: true,
      });

      const result = await debugService.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      });

      expect(result.debug).toBeDefined();
      expect(result.debug?.evaluation_time_ms).toBeDefined();
      expect(result.debug?.matched_rules).toBeDefined();
    });

    it('should not include debug info when debug mode is disabled', async () => {
      const result = await service.check({
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      });

      expect(result.debug).toBeUndefined();
    });
  });

  describe('Default Values', () => {
    it('should reject missing tenant_id', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
      };

      await expect(service.check(request)).rejects.toThrow(
        'UnifiedCheckService requires tenant_id'
      );
    });

    it('should use default subject_type of user', async () => {
      const request: CheckApiRequest = {
        subject_id: 'user_123',
        permission: 'documents:read',
        tenant_id: 'default',
      };

      const result = await service.check(request);

      // Should not throw - subject_type defaults to 'user'
      expect(result).toBeDefined();
    });
  });
});
