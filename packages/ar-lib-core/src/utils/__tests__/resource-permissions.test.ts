/**
 * Resource Permissions Utility Tests
 *
 * Tests for ID-level permission evaluation and scope parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the D1 database
const mockD1 = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn(),
  first: vi.fn(),
};

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
    mockD1.all.mockResolvedValue({ results: [] });
    mockD1.first.mockResolvedValue(null);
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

  describe('getUserIdLevelPermissions', () => {
    it('should return empty array when no permissions exist', async () => {
      mockD1.all.mockResolvedValue({ results: [] });

      const result = await getUserIdLevelPermissions(
        mockD1 as unknown as D1Database,
        'user_123',
        'default'
      );

      expect(result).toEqual([]);
    });

    it('should return formatted permissions when permissions exist', async () => {
      mockD1.all.mockResolvedValue({
        results: [
          {
            id: 'perm_1',
            tenant_id: 'default',
            subject_type: 'user',
            subject_id: 'user_123',
            resource_type: 'documents',
            resource_id: 'doc_123',
            actions_json: '["read", "write"]',
            condition_json: null,
            expires_at: null,
            is_active: 1,
            created_at: 1700000000,
            updated_at: 1700000000,
          },
          {
            id: 'perm_2',
            tenant_id: 'default',
            subject_type: 'user',
            subject_id: 'user_123',
            resource_type: 'projects',
            resource_id: 'proj_456',
            actions_json: '["manage"]',
            condition_json: null,
            expires_at: null,
            is_active: 1,
            created_at: 1700000000,
            updated_at: 1700000000,
          },
        ],
      });

      const result = await getUserIdLevelPermissions(
        mockD1 as unknown as D1Database,
        'user_123',
        'default'
      );

      expect(result).toHaveLength(2);
      expect(result[0].actions).toEqual(['read', 'write']);
      expect(result[0].resource_type).toBe('documents');
      expect(result[1].actions).toEqual(['manage']);
      expect(result[1].resource_type).toBe('projects');
    });
  });

  describe('evaluateIdLevelPermissions', () => {
    it('should return empty array when no permissions exist', async () => {
      mockD1.all.mockResolvedValue({ results: [] });

      const result = await evaluateIdLevelPermissions(
        mockD1 as unknown as D1Database,
        'user_123',
        'default'
      );

      expect(result).toEqual([]);
    });

    it('should return formatted permission strings', async () => {
      mockD1.all.mockResolvedValue({
        results: [
          {
            id: 'perm_1',
            tenant_id: 'default',
            subject_type: 'user',
            subject_id: 'user_123',
            resource_type: 'documents',
            resource_id: 'doc_123',
            actions_json: '["read", "write"]',
            condition_json: null,
            expires_at: null,
            is_active: 1,
            created_at: 1700000000,
            updated_at: 1700000000,
          },
        ],
      });

      const result = await evaluateIdLevelPermissions(
        mockD1 as unknown as D1Database,
        'user_123',
        'default'
      );

      expect(result).toEqual(['documents:doc_123:read', 'documents:doc_123:write']);
    });

    it('should use cache when available', async () => {
      mockKV.get.mockResolvedValue(JSON.stringify(['cached:perm:read']));

      const result = await evaluateIdLevelPermissions(
        mockD1 as unknown as D1Database,
        'user_123',
        'default',
        { cache: mockKV as unknown as KVNamespace }
      );

      expect(result).toEqual(['cached:perm:read']);
      expect(mockD1.prepare).not.toHaveBeenCalled();
    });

    it('should fetch from database and cache result', async () => {
      mockKV.get.mockResolvedValue(null);
      mockD1.all.mockResolvedValue({
        results: [
          {
            id: 'perm_1',
            tenant_id: 'default',
            subject_type: 'user',
            subject_id: 'user_123',
            resource_type: 'documents',
            resource_id: 'doc_123',
            actions_json: '["read"]',
            condition_json: null,
            expires_at: null,
            is_active: 1,
            created_at: 1700000000,
            updated_at: 1700000000,
          },
        ],
      });

      await evaluateIdLevelPermissions(mockD1 as unknown as D1Database, 'user_123', 'default', {
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
      mockD1.first.mockResolvedValue({ '1': 1 });
      mockD1.all.mockResolvedValue({
        results: [{ actions_json: '["read", "write"]' }],
      });

      const result = await hasIdLevelPermission(
        mockD1 as unknown as D1Database,
        'user_123',
        'documents',
        'doc_456',
        'read',
        'default'
      );

      expect(result).toBe(true);
    });

    it('should return false when permission row does not exist', async () => {
      mockD1.first.mockResolvedValue(null);

      const result = await hasIdLevelPermission(
        mockD1 as unknown as D1Database,
        'user_123',
        'documents',
        'doc_456',
        'delete',
        'default'
      );

      expect(result).toBe(false);
    });

    it('should return false when action is not in actions_json', async () => {
      mockD1.first.mockResolvedValue({ '1': 1 });
      mockD1.all.mockResolvedValue({
        results: [{ actions_json: '["read"]' }], // Only read, not write
      });

      const result = await hasIdLevelPermission(
        mockD1 as unknown as D1Database,
        'user_123',
        'documents',
        'doc_456',
        'write', // Requesting write
        'default'
      );

      expect(result).toBe(false);
    });

    it('should return true when permission includes wildcard action', async () => {
      mockD1.first.mockResolvedValue({ '1': 1 });
      mockD1.all.mockResolvedValue({
        results: [{ actions_json: '["*"]' }],
      });

      const result = await hasIdLevelPermission(
        mockD1 as unknown as D1Database,
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
