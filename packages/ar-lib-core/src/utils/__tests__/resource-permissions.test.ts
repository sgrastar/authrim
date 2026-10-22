/**
 * Resource Permissions Utility Tests
 *
 * Tests for ID-level permission evaluation and scope parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mock D1 database that answers by the table a query reads. Role definitions and the grants in
 * `resource_permissions` are tenant settings (metadata database); a subject's role assignments
 * are account data (account database), so each test database holds only its own tables. Every
 * bound statement is recorded in `calls`.
 */
function createMockD1(tables: {
  roles?: unknown[];
  role_assignments?: unknown[];
  resource_permissions?: unknown[];
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const table = (['role_assignments', 'roles', 'resource_permissions'] as const).find((name) =>
        sql.includes(`FROM ${name}`)
      );
      const statement = {
        bind: vi.fn(),
        all: vi.fn().mockResolvedValue({ results: (table && tables[table]) ?? [] }),
        first: vi.fn().mockResolvedValue(null),
      };
      statement.bind.mockImplementation((...params: unknown[]) => {
        calls.push({ sql, params });
        return statement;
      });
      return statement;
    }),
  };
  return Object.assign(db as unknown as D1Database, { calls, prepare: db.prepare });
}

/** The two databases of the tenant: metadata (grants) and account (assignments) */
function createMockDatabases(tables: {
  roles?: unknown[];
  role_assignments?: unknown[];
  resource_permissions?: unknown[];
}) {
  const metadata = createMockD1({
    roles: tables.roles,
    resource_permissions: tables.resource_permissions,
  });
  const account = createMockD1({ role_assignments: tables.role_assignments });
  return { metadata, account };
}

const roleRow = (id: string, name: string) => ({
  id,
  name,
  display_name: null,
  description: null,
  permissions_json: '[]',
  role_type: 'custom',
  hierarchy_level: null,
  is_assignable: 1,
  is_system: 0,
  parent_role_id: null,
});
const assignmentRow = (roleId: string) => ({
  id: `ra-${roleId}`,
  role_id: roleId,
  scope_type: 'global',
  scope_target: '',
  expires_at: null,
  assigned_by: null,
  created_at: 1,
});

// Mock KV namespace
const mockKV = {
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
};

import {
  parseScopeWithIdLevel,
  formatIdLevelPermission,
  evaluateIdLevelPermissions,
  hasIdLevelPermission,
  getUserIdLevelPermissions,
  isCustomClaimsEnabled,
  isIdLevelPermissionsEnabled,
  getEmbeddingLimits,
  invalidateIdPermissionCache,
} from '../resource-permissions';

describe('Resource Permissions Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKV.get.mockResolvedValue(null);
  });

  describe('parseScopeWithIdLevel', () => {
    it('should parse type-level scopes correctly', () => {
      const result = parseScopeWithIdLevel('documents:read users:write');

      expect(result.typeLevel).toEqual(['documents:read', 'users:write']);
      expect(result.idLevel).toEqual([]);
      expect(result.standard).toEqual([]);
    });

    it('should parse ID-level scopes correctly', () => {
      const result = parseScopeWithIdLevel('documents:doc_123:read projects:proj_456:manage');

      expect(result.typeLevel).toEqual([]);
      expect(result.idLevel).toEqual([
        {
          resource: 'documents',
          id: 'doc_123',
          action: 'read',
          original: 'documents:doc_123:read',
        },
        {
          resource: 'projects',
          id: 'proj_456',
          action: 'manage',
          original: 'projects:proj_456:manage',
        },
      ]);
    });

    it('should parse mixed scopes correctly', () => {
      const result = parseScopeWithIdLevel(
        'openid profile documents:read documents:doc_123:write users:user_789:delete'
      );

      expect(result.standard).toContain('openid');
      expect(result.standard).toContain('profile');
      expect(result.typeLevel).toEqual(['documents:read']);
      expect(result.idLevel).toEqual([
        {
          resource: 'documents',
          id: 'doc_123',
          action: 'write',
          original: 'documents:doc_123:write',
        },
        { resource: 'users', id: 'user_789', action: 'delete', original: 'users:user_789:delete' },
      ]);
    });

    it('should handle empty scope string', () => {
      const result = parseScopeWithIdLevel('');

      expect(result.typeLevel).toEqual([]);
      expect(result.idLevel).toEqual([]);
      expect(result.standard).toEqual([]);
    });

    it('should handle scope with extra whitespace', () => {
      const result = parseScopeWithIdLevel('  documents:read   users:user_123:write  ');

      expect(result.typeLevel).toEqual(['documents:read']);
      expect(result.idLevel).toEqual([
        { resource: 'users', id: 'user_123', action: 'write', original: 'users:user_123:write' },
      ]);
    });

    it('should identify standard OIDC scopes', () => {
      const result = parseScopeWithIdLevel('openid profile email address phone offline_access');

      expect(result.standard).toHaveLength(6);
      expect(result.standard).toContain('openid');
      expect(result.standard).toContain('profile');
      expect(result.standard).toContain('email');
      expect(result.standard).toContain('address');
      expect(result.standard).toContain('phone');
      expect(result.standard).toContain('offline_access');
      expect(result.typeLevel).toEqual([]);
      expect(result.idLevel).toEqual([]);
    });
  });

  describe('formatIdLevelPermission', () => {
    it('should format ID-level permission correctly', () => {
      const result = formatIdLevelPermission('documents', 'doc_123', 'read');

      expect(result).toBe('documents:doc_123:read');
    });

    it('should handle special characters in resource ID', () => {
      const result = formatIdLevelPermission('files', 'file-with-dashes_and_underscores', 'write');

      expect(result).toBe('files:file-with-dashes_and_underscores:write');
    });
  });

  const permissionRow = (
    id: string,
    resourceType: string,
    resourceId: string,
    actionsJson: string,
    subject: { type: string; id: string } = { type: 'user', id: 'user_123' }
  ) => ({
    id,
    tenant_id: 'default',
    subject_type: subject.type,
    subject_id: subject.id,
    resource_type: resourceType,
    resource_id: resourceId,
    actions_json: actionsJson,
    condition_json: null,
    expires_at: null,
    is_active: 1,
    created_at: 1700000000,
    updated_at: 1700000000,
  });

  describe('getUserIdLevelPermissions', () => {
    it('should return empty array when no permissions exist', async () => {
      const dbs = createMockDatabases({ resource_permissions: [] });

      const result = await getUserIdLevelPermissions(dbs, 'user_123', 'default');

      expect(result).toEqual([]);
    });

    it('should return formatted permissions when permissions exist', async () => {
      const dbs = createMockDatabases({
        resource_permissions: [
          permissionRow('perm_1', 'documents', 'doc_123', '["read", "write"]'),
          permissionRow('perm_2', 'projects', 'proj_456', '["manage"]'),
        ],
      });

      const result = await getUserIdLevelPermissions(dbs, 'user_123', 'default');

      expect(result).toHaveLength(2);
      expect(result[0].actions).toEqual(['read', 'write']);
      expect(result[0].resource_type).toBe('documents');
      expect(result[1].actions).toEqual(['manage']);
      expect(result[1].resource_type).toBe('projects');
    });

    it('should include grants to the roles the subject is assigned, read from both databases', async () => {
      // Assignments are in the account database, role definitions and grants in the metadata database
      const dbs = createMockDatabases({
        role_assignments: [assignmentRow('role_editor'), assignmentRow('role_deleted')],
        roles: [roleRow('role_editor', 'editor')],
        resource_permissions: [
          permissionRow('perm_role', 'documents', 'doc_9', '["edit"]', {
            type: 'role',
            id: 'role_editor',
          }),
        ],
      });

      const result = await getUserIdLevelPermissions(dbs, 'user_123', 'default');

      expect(result.map((permission) => permission.id)).toEqual(['perm_role']);

      const assignmentQuery = dbs.account.calls.find(({ sql }) =>
        sql.includes('FROM role_assignments')
      );
      expect(assignmentQuery?.params.slice(0, 2)).toEqual(['default', 'user_123']);
      expect(dbs.account.calls.some(({ sql }) => sql.includes('FROM resource_permissions'))).toBe(
        false
      );

      // Grants are read from the metadata database: first the subject's own, then its roles'
      const grantQueries = dbs.metadata.calls.filter(({ sql }) =>
        sql.includes('FROM resource_permissions')
      );
      expect(grantQueries).toHaveLength(2);
      expect(grantQueries[0].sql).toContain("subject_type = 'user' AND subject_id = ?");
      expect(grantQueries[0].params).toEqual(['default', expect.any(Number), 'user_123']);
      expect(grantQueries[1].sql).toContain("subject_type = 'role' AND subject_id IN (?)");
      // Only the role the tenant still has is asked for: the deleted role's assignment grants nothing
      expect(grantQueries[1].params).toEqual(['default', expect.any(Number), 'role_editor']);
    });
  });

  describe('evaluateIdLevelPermissions', () => {
    it('should return empty array when no permissions exist', async () => {
      const dbs = createMockDatabases({ resource_permissions: [] });

      const result = await evaluateIdLevelPermissions(dbs, 'user_123', 'default');

      expect(result).toEqual([]);
    });

    it('should return formatted permission strings', async () => {
      const dbs = createMockDatabases({
        resource_permissions: [
          permissionRow('perm_1', 'documents', 'doc_123', '["read", "write"]'),
        ],
      });

      const result = await evaluateIdLevelPermissions(dbs, 'user_123', 'default');

      expect(result).toEqual(['documents:doc_123:read', 'documents:doc_123:write']);
    });

    it('should use cache when available', async () => {
      mockKV.get.mockResolvedValue(JSON.stringify(['cached:perm:read']));
      const dbs = createMockDatabases({});

      const result = await evaluateIdLevelPermissions(dbs, 'user_123', 'default', {
        cache: mockKV as unknown as KVNamespace,
      });

      expect(result).toEqual(['cached:perm:read']);
      expect(dbs.metadata.prepare).not.toHaveBeenCalled();
      expect(dbs.account.prepare).not.toHaveBeenCalled();
    });

    it('should fetch from database and cache result', async () => {
      mockKV.get.mockResolvedValue(null);
      const dbs = createMockDatabases({
        resource_permissions: [permissionRow('perm_1', 'documents', 'doc_123', '["read"]')],
      });

      await evaluateIdLevelPermissions(dbs, 'user_123', 'default', {
        cache: mockKV as unknown as KVNamespace,
      });

      expect(mockKV.put).toHaveBeenCalledWith(
        'policy:idperms:default:user_123',
        '["documents:doc_123:read"]',
        { expirationTtl: 300 }
      );
    });
  });

  describe('hasIdLevelPermission', () => {
    it('should return true when user has the permission with action', async () => {
      const dbs = createMockDatabases({
        resource_permissions: [{ actions_json: '["read", "write"]' }],
      });

      const result = await hasIdLevelPermission(
        dbs,
        'user_123',
        'documents',
        'doc_456',
        'read',
        'default'
      );

      expect(result).toBe(true);
      // The grant is looked up on the metadata database for this tenant, resource and subject
      const grantQuery = dbs.metadata.calls.find(({ sql }) =>
        sql.includes('FROM resource_permissions')
      );
      expect(grantQuery?.params).toEqual([
        'default',
        'documents',
        'doc_456',
        expect.any(Number),
        'user_123',
      ]);
    });

    it('should return true when the action is granted to a role of the subject', async () => {
      const dbs = createMockDatabases({
        role_assignments: [assignmentRow('role_editor')],
        roles: [roleRow('role_editor', 'editor')],
        resource_permissions: [{ actions_json: '["read"]' }],
      });

      const result = await hasIdLevelPermission(
        dbs,
        'user_123',
        'documents',
        'doc_456',
        'read',
        'default'
      );

      expect(result).toBe(true);
      expect(
        dbs.metadata.calls.some(
          ({ sql, params }) =>
            sql.includes('FROM resource_permissions') && params.includes('role_editor')
        )
      ).toBe(true);
    });

    it('should return false when permission row does not exist', async () => {
      const dbs = createMockDatabases({ resource_permissions: [] });

      const result = await hasIdLevelPermission(
        dbs,
        'user_123',
        'documents',
        'doc_456',
        'delete',
        'default'
      );

      expect(result).toBe(false);
    });

    it('should return false when action is not in actions_json', async () => {
      const dbs = createMockDatabases({
        resource_permissions: [{ actions_json: '["read"]' }], // Only read, not write
      });

      const result = await hasIdLevelPermission(
        dbs,
        'user_123',
        'documents',
        'doc_456',
        'write', // Requesting write
        'default'
      );

      expect(result).toBe(false);
    });

    it('should return true when permission includes wildcard action', async () => {
      const dbs = createMockDatabases({
        resource_permissions: [{ actions_json: '["*"]' }],
      });

      const result = await hasIdLevelPermission(
        dbs,
        'user_123',
        'documents',
        'doc_456',
        'any_action',
        'default'
      );

      expect(result).toBe(true);
    });
  });

  describe('Feature Flags', () => {
    // A new store for each read: the older values are cached per store for a minute.
    const freshKv = (get: (key: string) => Promise<string | null>) =>
      ({ get: vi.fn(get) }) as unknown as KVNamespace;

    describe('isCustomClaimsEnabled', () => {
      it('should return false by default', async () => {
        const result = await isCustomClaimsEnabled({});
        expect(result).toBe(false);
      });

      it('should return true when env var is set', async () => {
        const result = await isCustomClaimsEnabled({ ENABLE_CUSTOM_CLAIMS: 'true' });
        expect(result).toBe(true);
      });

      it("should prefer the platform's saved value over env var", async () => {
        const kv = freshKv(async (key: string) =>
          key === 'settings:platform:feature-flags'
            ? JSON.stringify({ 'feature.enable_custom_claims': false })
            : null
        );

        const result = await isCustomClaimsEnabled({
          SETTINGS: kv,
          ENABLE_CUSTOM_CLAIMS: 'true',
        });

        expect(result).toBe(false);
      });

      it("takes the tenant's value over the platform's, and env only as 'true'", async () => {
        const kv = freshKv(async (key: string) =>
          key === 'settings:tenant:acme:feature-flags'
            ? JSON.stringify({ 'feature.enable_custom_claims': true })
            : key === 'settings:platform:feature-flags'
              ? JSON.stringify({ 'feature.enable_custom_claims': false })
              : null
        );
        await expect(isCustomClaimsEnabled({ SETTINGS: kv }, 'acme')).resolves.toBe(true);
        await expect(isCustomClaimsEnabled({ ENABLE_CUSTOM_CLAIMS: '1' })).resolves.toBe(false);
      });
    });

    it.each([
      ['a read failure', async () => Promise.reject(new Error('kv unavailable'))],
      ['a document that is not JSON', async () => 'not json'],
    ])('keeps both token switches off after %s, even if env enables them', async (_label, get) => {
      const env = {
        SETTINGS: freshKv(get),
        ENABLE_CUSTOM_CLAIMS: 'true',
        ENABLE_ID_LEVEL_PERMISSIONS: 'true',
      };
      await expect(isCustomClaimsEnabled(env, 'acme')).resolves.toBe(false);
      await expect(isIdLevelPermissionsEnabled(env)).resolves.toBe(false);
    });

    describe('isIdLevelPermissionsEnabled', () => {
      it('should return false by default', async () => {
        const result = await isIdLevelPermissionsEnabled({});
        expect(result).toBe(false);
      });

      it('should return true when env var is set', async () => {
        const result = await isIdLevelPermissionsEnabled({ ENABLE_ID_LEVEL_PERMISSIONS: 'true' });
        expect(result).toBe(true);
      });

      it("should prefer the platform's saved value over env var", async () => {
        const kv = freshKv(async (key: string) =>
          key === 'settings:platform:feature-flags'
            ? JSON.stringify({ 'feature.enable_id_level_permissions': true })
            : null
        );

        const result = await isIdLevelPermissionsEnabled({
          SETTINGS: kv,
          ENABLE_ID_LEVEL_PERMISSIONS: 'false',
        });

        expect(result).toBe(true);
      });
    });

    describe('getEmbeddingLimits', () => {
      it('should return default limits when no config', async () => {
        const result = await getEmbeddingLimits({});

        expect(result.max_embedded_permissions).toBe(50);
        expect(result.max_resource_permissions).toBe(100);
        expect(result.max_custom_claims).toBe(20);
      });

      it('should use env vars when set', async () => {
        const result = await getEmbeddingLimits({
          MAX_EMBEDDED_PERMISSIONS: '75',
          MAX_RESOURCE_PERMISSIONS: '150',
          MAX_CUSTOM_CLAIMS: '30',
        });

        expect(result.max_embedded_permissions).toBe(75);
        expect(result.max_resource_permissions).toBe(150);
        expect(result.max_custom_claims).toBe(30);
      });

      it('should prefer KV values over env vars', async () => {
        mockKV.get.mockImplementation((key: string) => {
          if (key === 'settings:platform:limits') {
            return JSON.stringify({ 'limits.max_embedded_permissions': 200 });
          }
          return null;
        });

        const result = await getEmbeddingLimits({
          SETTINGS: mockKV as unknown as KVNamespace,
          MAX_EMBEDDED_PERMISSIONS: '75',
        });

        expect(result.max_embedded_permissions).toBe(200);
      });
    });
  });

  describe('invalidateIdPermissionCache', () => {
    it('should delete cache entry', async () => {
      await invalidateIdPermissionCache(mockKV as unknown as KVNamespace, 'user_123', 'default');

      expect(mockKV.delete).toHaveBeenCalledWith('policy:idperms:default:user_123');
    });
  });

  describe('Edge Cases', () => {
    it('should handle malformed scope strings gracefully', () => {
      // Just colons - should be ignored (not 2 or 3 parts)
      const result1 = parseScopeWithIdLevel(':::');
      expect(result1.typeLevel).toEqual([]);
      expect(result1.idLevel).toEqual([]);

      // Empty parts - 3 parts with empty middle = valid ID-level scope
      const result2 = parseScopeWithIdLevel('documents::read');
      expect(result2.idLevel).toEqual([
        { resource: 'documents', id: '', action: 'read', original: 'documents::read' },
      ]);
    });

    it('should handle very long resource IDs', () => {
      const longId = 'a'.repeat(256);
      const result = parseScopeWithIdLevel(`documents:${longId}:read`);

      expect(result.idLevel).toEqual([
        { resource: 'documents', id: longId, action: 'read', original: `documents:${longId}:read` },
      ]);
    });

    it('should handle unicode in resource types and IDs', () => {
      // Note: While unicode is technically supported, it's not recommended
      const result = formatIdLevelPermission('文書', 'doc_日本語', '読む');
      expect(result).toBe('文書:doc_日本語:読む');
    });
  });
});
