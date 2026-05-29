import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getConsentRBACData,
  validateConsentOrgAccess,
  validateActingAsRelationship,
  getActingAsUserInfo,
  getConsentUserInfo,
  parseConsentFeatureFlags,
  getRolesInOrganization,
} from '../consent-rbac';
import type { D1Database } from '@cloudflare/workers-types';

/**
 * Consent RBAC Utility Tests
 *
 * Phase 2-B: Consent Screen Enhancement
 *
 * Tests for:
 * - Organization membership retrieval
 * - Organization access validation
 * - Acting-as relationship validation
 * - User info retrieval
 * - Feature flag parsing
 * - Role retrieval by organization
 */

/**
 * Helper to create mock D1 database with configurable query results
 */
function createMockDB(queryResults: Record<string, unknown>) {
  return {
    prepare: vi.fn((sql: string) => {
      // Determine which result to return based on SQL pattern
      let result: unknown = null;

      if (sql.includes('FROM organizations o') && sql.includes('JOIN subject_org_membership')) {
        if (sql.includes('WHERE o.id = ?')) {
          // validateConsentOrgAccess - single org lookup
          result = queryResults['validateOrgAccess'] ?? null;
        } else {
          // resolveAllOrganizationsWithPlan - list all orgs
          result = queryResults['allOrgs'] ?? { results: [] };
        }
      } else if (sql.includes('FROM role_assignments ra')) {
        if (sql.includes('scope_target')) {
          // getRolesInOrganization
          result = queryResults['rolesInOrg'] ?? { results: [] };
        } else {
          // resolveEffectiveRoles (from rbac-claims)
          result = queryResults['roles'] ?? { results: [] };
        }
      } else if (sql.includes('FROM relationships')) {
        result = queryResults['relationship'] ?? null;
      } else if (sql.includes('FROM identity_accounts')) {
        const user = (queryResults['userCore'] ?? queryResults['user']) as
          | { id: string; name?: string | null }
          | undefined;
        result = user
          ? {
              id: `account:${user.id}`,
              tenant_id: 'default',
              account_type: 'user',
              lifecycle_state: 'active',
              legacy_user_id: user.id,
              primary_subject_id: `subject:${user.id}`,
              display_label: user.name ?? null,
              metadata_json: null,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            }
          : null;
      } else if (sql.includes('FROM identity_subjects')) {
        const user = (queryResults['userCore'] ?? queryResults['user']) as
          | { id: string; name?: string | null }
          | undefined;
        result = user
          ? {
              id: `subject:${user.id}`,
              tenant_id: 'default',
              subject_type: 'person',
              lifecycle_state: 'active',
              display_label: user.name ?? null,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            }
          : null;
      } else if (sql.includes('FROM profiles')) {
        const user = (queryResults['userCore'] ?? queryResults['user']) as
          | { id: string }
          | undefined;
        result = user
          ? {
              id: `profile:${user.id}`,
              tenant_id: 'default',
              subject_id: `subject:${user.id}`,
              profile_type: 'default',
              lifecycle_state: 'active',
              locale: null,
              zoneinfo: null,
              created_at: 1,
              updated_at: 1,
              deleted_at: null,
            }
          : null;
      } else if (sql.includes('FROM profile_attribute_values')) {
        const subject = String(
          (queryResults['userCore'] as { id?: string } | undefined)?.id ??
            (queryResults['user'] as { id?: string } | undefined)?.id ??
            'user-123'
        );
        result = {
          results: ['name', 'picture'].map((field) => ({
            id: `attr:${subject}:${field}`,
            tenant_id: 'default',
            profile_id: `profile:${subject}`,
            catalog_entry_id: `field.canonical.${field}`,
            value_type: 'reference',
            value_json: null,
            value_storage_ref: `canonical-sensitive://default/${subject}/${field}`,
            classification: 'sensitive',
            purpose: 'profile',
            is_primary: 0,
            display_order: field === 'name' ? 0 : 1,
            lifecycle_state: 'active',
            created_at: 1,
            updated_at: 1,
            deleted_at: null,
          })),
        };
      } else if (sql.includes('FROM contact_points')) {
        const user = (queryResults['userCore'] ?? queryResults['user']) as
          | { id: string; email?: string; picture?: string | null }
          | undefined;
        result = user
          ? {
              results: [
                {
                  id: `contact:${user.id}:email`,
                  tenant_id: 'default',
                  subject_id: `subject:${user.id}`,
                  account_id: `account:${user.id}`,
                  contact_type: 'email',
                  purpose: 'primary',
                  normalized_hash: 'email',
                  value_storage_ref: `canonical-sensitive://default/${user.id}/email`,
                  is_primary: 1,
                  verification_state: 'verified',
                  lifecycle_state: 'active',
                  created_at: 1,
                  updated_at: 1,
                  deleted_at: null,
                },
              ],
            }
          : { results: [] };
      } else if (sql.includes('FROM users_core WHERE id')) {
        // PII/Non-PII separation: users_core returns { id } only
        result =
          (queryResults['userCore'] ?? queryResults['user'])
            ? {
                id:
                  (queryResults['userCore'] as { id: string })?.id ??
                  (queryResults['user'] as { id: string })?.id,
              }
            : null;
      }

      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(result),
        all: vi.fn().mockResolvedValue(result),
      };
    }),
  } as unknown as D1Database;
}

/**
 * Helper to create mock PII database with configurable query results
 * Used for PII/Non-PII DB separation
 */
function createMockPIIDB(queryResults: Record<string, unknown>) {
  return {
    prepare: vi.fn((sql: string) => {
      let result: unknown = null;
      let boundParams: unknown[] = [];

      if (sql.includes('FROM users_pii WHERE id')) {
        // users_pii returns { email, name, picture }
        const piiData = queryResults['userPII'] ?? queryResults['user'];
        if (piiData) {
          const user = piiData as { email?: string; name?: string | null; picture?: string | null };
          result = {
            email: user.email,
            name: user.name,
            picture: user.picture,
          };
        }
      } else if (sql.includes('FROM identity_sensitive_values')) {
        const piiData = queryResults['userPII'] ?? queryResults['user'];
        const user = piiData as
          | { email?: string; name?: string | null; picture?: string | null }
          | undefined;
        const key = String(boundParams[2] ?? 'email') as 'email' | 'name' | 'picture';
        const value = user?.[key];
        result = value === undefined ? null : { value_json: JSON.stringify(value) };
      }

      return {
        bind: vi.fn((...params: unknown[]) => {
          boundParams = params;
          return {
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('FROM identity_sensitive_values')) {
                const piiData = queryResults['userPII'] ?? queryResults['user'];
                const user = piiData as
                  | { email?: string; name?: string | null; picture?: string | null }
                  | undefined;
                const key = String(boundParams[2] ?? 'email') as 'email' | 'name' | 'picture';
                const value = user?.[key];
                return value === undefined ? null : { value_json: JSON.stringify(value) };
              }
              return result;
            }),
            all: vi.fn().mockResolvedValue(result),
          };
        }),
        first: vi.fn().mockResolvedValue(result),
        all: vi.fn().mockResolvedValue(result),
      };
    }),
  } as unknown as D1Database;
}

describe('Consent RBAC Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===========================================================================
  // getConsentRBACData
  // ===========================================================================

  describe('getConsentRBACData', () => {
    it('should return organizations and roles for a user', async () => {
      const db = createMockDB({
        allOrgs: {
          results: [
            {
              id: 'org-1',
              name: 'Primary Org',
              org_type: 'company',
              plan: 'enterprise',
              is_primary: 1,
            },
            {
              id: 'org-2',
              name: 'Secondary Org',
              org_type: 'department',
              plan: 'free',
              is_primary: 0,
            },
          ],
        },
        roles: { results: [{ name: 'admin' }, { name: 'user' }] },
      });

      const result = await getConsentRBACData(db, 'user-123', 'default');

      expect(result.organizations).toHaveLength(2);
      expect(result.organizations[0]).toEqual({
        id: 'org-1',
        name: 'Primary Org',
        type: 'company',
        plan: 'enterprise',
        is_primary: true,
      });
      expect(result.organizations[1]).toEqual({
        id: 'org-2',
        name: 'Secondary Org',
        type: 'department',
        plan: 'free',
        is_primary: false,
      });
      expect(result.primary_org).toEqual(result.organizations[0]);
      expect(result.roles).toEqual(['admin', 'user']);
    });

    it('should return null primary_org when user has no primary organization', async () => {
      const db = createMockDB({
        allOrgs: {
          results: [
            { id: 'org-1', name: 'Org A', org_type: 'company', plan: 'free', is_primary: 0 },
          ],
        },
        roles: { results: [] },
      });

      const result = await getConsentRBACData(db, 'user-123', 'default');

      expect(result.primary_org).toBeNull();
      expect(result.organizations).toHaveLength(1);
    });

    it('should return empty arrays when user has no memberships or roles', async () => {
      const db = createMockDB({
        allOrgs: { results: [] },
        roles: { results: [] },
      });

      const result = await getConsentRBACData(db, 'user-123', 'default');

      expect(result.organizations).toEqual([]);
      expect(result.primary_org).toBeNull();
      expect(result.roles).toEqual([]);
    });
  });

  // ===========================================================================
  // validateConsentOrgAccess
  // ===========================================================================

  describe('validateConsentOrgAccess', () => {
    it('should return valid result when user is member of organization', async () => {
      const db = createMockDB({
        validateOrgAccess: {
          id: 'org-1',
          name: 'Test Org',
          org_type: 'company',
          plan: 'enterprise',
          is_primary: 1,
        },
      });

      const result = await validateConsentOrgAccess(db, 'user-123', 'org-1', 'default');

      expect(result.valid).toBe(true);
      expect(result.organization).toEqual({
        id: 'org-1',
        name: 'Test Org',
        type: 'company',
        plan: 'enterprise',
        is_primary: true,
      });
      expect(result.error).toBeUndefined();
    });

    it('should return invalid result when user is not member', async () => {
      const db = createMockDB({
        validateOrgAccess: null,
      });

      const result = await validateConsentOrgAccess(db, 'user-123', 'org-not-member', 'default');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('User is not a member of the specified organization');
      expect(result.organization).toBeUndefined();
    });

    it('should handle non-primary organization', async () => {
      const db = createMockDB({
        validateOrgAccess: {
          id: 'org-2',
          name: 'Secondary Org',
          org_type: 'department',
          plan: 'free',
          is_primary: 0,
        },
      });

      const result = await validateConsentOrgAccess(db, 'user-123', 'org-2', 'default');

      expect(result.valid).toBe(true);
      expect(result.organization?.is_primary).toBe(false);
    });
  });

  // ===========================================================================
  // validateActingAsRelationship
  // ===========================================================================

  describe('validateActingAsRelationship', () => {
    it('should validate parent_child relationship', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'parent_child',
          permission_level: 'full',
        },
      });

      const result = await validateActingAsRelationship(db, 'parent-123', 'child-456', 'default');

      expect(result.valid).toBe(true);
      expect(result.relationship_type).toBe('parent_child');
      expect(result.permission_level).toBe('full');
      expect(result.error).toBeUndefined();
    });

    it('should validate guardian relationship', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'guardian',
          permission_level: 'manage',
        },
      });

      const result = await validateActingAsRelationship(db, 'guardian-123', 'ward-456', 'default');

      expect(result.valid).toBe(true);
      expect(result.relationship_type).toBe('guardian');
      expect(result.permission_level).toBe('manage');
    });

    it('should validate delegate relationship', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'delegate',
          permission_level: 'read',
        },
      });

      const result = await validateActingAsRelationship(
        db,
        'delegate-123',
        'principal-456',
        'default'
      );

      expect(result.valid).toBe(true);
      expect(result.relationship_type).toBe('delegate');
      expect(result.permission_level).toBe('read');
    });

    it('should return invalid when no relationship exists', async () => {
      const db = createMockDB({
        relationship: null,
      });

      const result = await validateActingAsRelationship(db, 'user-123', 'user-456', 'default');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('No valid acting-as relationship exists');
      expect(result.relationship_type).toBeUndefined();
      expect(result.permission_level).toBeUndefined();
    });
  });

  // ===========================================================================
  // getActingAsUserInfo
  // ===========================================================================

  describe('getActingAsUserInfo', () => {
    it('should return acting-as user info when relationship is valid', async () => {
      // PII/Non-PII DB Separation:
      // - Core DB (db) returns relationship and { id } from users_core
      // - PII DB (dbPII) returns { email, name } from users_pii
      const db = createMockDB({
        relationship: {
          relationship_type: 'parent_child',
          permission_level: 'full',
        },
        user: { id: 'child-456' },
      });
      const dbPII = createMockPIIDB({
        user: {
          email: 'child@example.com',
          name: 'Child User',
        },
      });

      const result = await getActingAsUserInfo(db, 'parent-123', 'child-456', 'default', dbPII);

      expect(result).toEqual({
        id: 'child-456',
        email: 'child@example.com',
        name: 'Child User',
        relationship_type: 'parent_child',
        permission_level: 'full',
      });
    });

    it('should return null when relationship is invalid', async () => {
      const db = createMockDB({
        relationship: null,
      });

      const result = await getActingAsUserInfo(db, 'user-123', 'user-456', 'default');

      expect(result).toBeNull();
    });

    it('should return null when target user not found', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'delegate',
          permission_level: 'read',
        },
        user: null,
      });

      const result = await getActingAsUserInfo(db, 'delegate-123', 'deleted-user', 'default');

      expect(result).toBeNull();
    });

    it('should handle user without name', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'guardian',
          permission_level: 'manage',
        },
        user: { id: 'ward-456' },
      });
      const dbPII = createMockPIIDB({
        user: {
          email: 'ward@example.com',
          name: null,
        },
      });

      const result = await getActingAsUserInfo(db, 'guardian-123', 'ward-456', 'default', dbPII);

      expect(result?.name).toBeUndefined();
      expect(result?.email).toBe('ward@example.com');
    });

    it('should fallback to target ID for email when PII DB not provided', async () => {
      const db = createMockDB({
        relationship: {
          relationship_type: 'delegate',
          permission_level: 'read',
        },
        user: { id: 'target-456' },
      });

      const result = await getActingAsUserInfo(db, 'actor-123', 'target-456', 'default');

      expect(result?.email).toBe('target-456'); // Fallback to target ID
      expect(result?.name).toBeUndefined();
    });
  });

  // ===========================================================================
  // getConsentUserInfo
  // ===========================================================================

  describe('getConsentUserInfo', () => {
    it('should return user info with all fields', async () => {
      // PII/Non-PII DB Separation:
      // - Core DB (db) returns { id } from users_core
      // - PII DB (dbPII) returns { email, name, picture } from users_pii
      const db = createMockDB({
        user: { id: 'user-123' },
      });
      const dbPII = createMockPIIDB({
        user: {
          email: 'user@example.com',
          name: 'Test User',
          picture: 'https://example.com/avatar.jpg',
        },
      });

      const result = await getConsentUserInfo(db, 'user-123', 'default', dbPII);

      expect(result).toEqual({
        id: 'user-123',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/avatar.jpg',
      });
    });

    it('should handle null name and picture', async () => {
      const db = createMockDB({
        user: { id: 'user-123' },
      });
      const dbPII = createMockPIIDB({
        user: {
          email: 'user@example.com',
          name: null,
          picture: null,
        },
      });

      const result = await getConsentUserInfo(db, 'user-123', 'default', dbPII);

      expect(result?.name).toBeUndefined();
      expect(result?.picture).toBeUndefined();
      expect(result?.email).toBe('user@example.com');
    });

    it('should return null when user not found', async () => {
      const db = createMockDB({
        user: null,
      });

      const result = await getConsentUserInfo(db, 'nonexistent-user', 'default');

      expect(result).toBeNull();
    });

    it('should fallback to subject ID for email when PII DB not provided', async () => {
      const db = createMockDB({
        user: { id: 'user-123' },
      });

      // Without dbPII, email falls back to subjectId
      const result = await getConsentUserInfo(db, 'user-123', 'default');

      expect(result).toEqual({
        id: 'user-123',
        email: 'user-123', // Fallback to subject ID
        name: undefined,
        picture: undefined,
      });
    });
  });

  // ===========================================================================
  // parseConsentFeatureFlags
  // ===========================================================================

  describe('parseConsentFeatureFlags', () => {
    it('should parse all flags enabled', () => {
      const result = parseConsentFeatureFlags('true', 'true', 'true');

      expect(result).toEqual({
        org_selector_enabled: true,
        acting_as_enabled: true,
        show_roles: true,
      });
    });

    it('should parse all flags disabled', () => {
      const result = parseConsentFeatureFlags('false', 'false', 'false');

      expect(result).toEqual({
        org_selector_enabled: false,
        acting_as_enabled: false,
        show_roles: false,
      });
    });

    it('should parse undefined flags as false', () => {
      const result = parseConsentFeatureFlags(undefined, undefined, undefined);

      expect(result).toEqual({
        org_selector_enabled: false,
        acting_as_enabled: false,
        show_roles: false,
      });
    });

    it('should parse mixed flags', () => {
      const result = parseConsentFeatureFlags('true', undefined, 'false');

      expect(result).toEqual({
        org_selector_enabled: true,
        acting_as_enabled: false,
        show_roles: false,
      });
    });

    it('should treat non-"true" values as false', () => {
      const result = parseConsentFeatureFlags('TRUE', '1', 'yes');

      expect(result).toEqual({
        org_selector_enabled: false,
        acting_as_enabled: false,
        show_roles: false,
      });
    });
  });

  // ===========================================================================
  // getRolesInOrganization
  // ===========================================================================

  describe('getRolesInOrganization', () => {
    it('should return roles for specific organization', async () => {
      const db = createMockDB({
        rolesInOrg: {
          results: [{ name: 'org_admin' }, { name: 'member' }],
        },
      });

      const result = await getRolesInOrganization(db, 'user-123', 'org-1');

      expect(result).toEqual(['org_admin', 'member']);
    });

    it('should return empty array when no roles found', async () => {
      const db = createMockDB({
        rolesInOrg: { results: [] },
      });

      const result = await getRolesInOrganization(db, 'user-123', 'org-1');

      expect(result).toEqual([]);
    });

    it('should call DB with correct parameters', async () => {
      const prepareMock = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      });
      const db = { prepare: prepareMock } as unknown as D1Database;

      await getRolesInOrganization(db, 'user-123', 'org-456');

      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('FROM role_assignments ra'));
      expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('scope_target'));
    });
  });
});
