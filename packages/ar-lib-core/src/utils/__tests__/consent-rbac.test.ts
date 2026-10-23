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
 *
 * Role and organisation definitions (`roles`, `organizations`) live in the metadata database and
 * assignments (`role_assignments`, `subject_org_membership`) in the account database, so a test
 * gives each of the two databases only the tables it holds. Every bound statement is recorded in
 * `calls`.
 */
function createMockDB(queryResults: Record<string, unknown>) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      // Determine which result to return based on SQL pattern
      let result: unknown = null;

      if (sql.includes('FROM organizations')) {
        result = queryResults['organizations'] ?? { results: [] };
      } else if (sql.includes('FROM subject_org_membership')) {
        result = queryResults['memberships'] ?? { results: [] };
      } else if (sql.includes('FROM role_assignments')) {
        result = queryResults['roleAssignments'] ?? { results: [] };
      } else if (sql.includes('FROM roles')) {
        result = queryResults['roles'] ?? { results: [] };
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

      const statement = {
        bind: vi.fn(),
        first: vi.fn().mockResolvedValue(result),
        all: vi.fn().mockResolvedValue(result),
      };
      statement.bind.mockImplementation((...params: unknown[]) => {
        calls.push({ sql, params });
        return statement;
      });
      return statement;
    }),
  };
  return Object.assign(db as unknown as D1Database, { calls });
}

/** Rows of the `roles` / `organizations` / assignment tables the tests below share */
const role = (id: string, name: string) => ({
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
const assignment = (roleId: string, scopeType = 'global', scopeTarget = '') => ({
  id: `ra-${roleId}-${scopeTarget}`,
  role_id: roleId,
  scope_type: scopeType,
  scope_target: scopeTarget,
  expires_at: null,
  assigned_by: null,
  created_at: 1,
});
const organization = (id: string, name: string, orgType: string, plan: string, isActive = 1) => ({
  id,
  name,
  display_name: null,
  org_type: orgType,
  plan,
  parent_org_id: null,
  is_active: isActive,
});
const membership = (orgId: string, isPrimary: number) => ({
  id: `m-${orgId}`,
  org_id: orgId,
  membership_type: 'member',
  is_primary: isPrimary,
  created_at: 1,
});

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
      // Definitions come from the metadata database, assignments from the account database
      const metadata = createMockDB({
        organizations: {
          results: [
            organization('org-1', 'Primary Org', 'company', 'enterprise'),
            organization('org-2', 'Secondary Org', 'department', 'free'),
          ],
        },
        roles: { results: [role('role-admin', 'admin'), role('role-user', 'user')] },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-2', 0), membership('org-1', 1)] },
        roleAssignments: { results: [assignment('role-user'), assignment('role-admin')] },
      });

      const result = await getConsentRBACData({ metadata, account }, 'user-123', 'default');

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

      // The subject's assignments are read from the account database only, definitions from metadata
      expect(account.calls.map(({ sql }) => sql).join('\n')).not.toMatch(
        /FROM (roles|organizations)/
      );
      expect(metadata.calls.map(({ sql }) => sql).join('\n')).not.toMatch(
        /FROM (role_assignments|subject_org_membership)/
      );
    });

    it('should return null primary_org when user has no primary organization', async () => {
      const metadata = createMockDB({
        organizations: { results: [organization('org-1', 'Org A', 'company', 'free')] },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-1', 0)] },
      });

      const result = await getConsentRBACData({ metadata, account }, 'user-123', 'default');

      expect(result.primary_org).toBeNull();
      expect(result.organizations).toHaveLength(1);
    });

    it('should return empty arrays when user has no memberships or roles', async () => {
      const metadata = createMockDB({});
      const account = createMockDB({});

      const result = await getConsentRBACData({ metadata, account }, 'user-123', 'default');

      expect(result.organizations).toEqual([]);
      expect(result.primary_org).toBeNull();
      expect(result.roles).toEqual([]);
    });

    it('should leave out deactivated organizations and assignments of roles that no longer exist', async () => {
      const metadata = createMockDB({
        organizations: {
          results: [
            organization('org-1', 'Active Org', 'company', 'free'),
            organization('org-2', 'Closed Org', 'company', 'free', 0),
          ],
        },
        roles: { results: [role('role-user', 'user')] },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-1', 1), membership('org-2', 0)] },
        roleAssignments: { results: [assignment('role-user'), assignment('role-deleted')] },
      });

      const result = await getConsentRBACData({ metadata, account }, 'user-123', 'default');

      expect(result.organizations.map((org) => org.id)).toEqual(['org-1']);
      expect(result.roles).toEqual(['user']);
    });
  });

  // ===========================================================================
  // validateConsentOrgAccess
  // ===========================================================================

  describe('validateConsentOrgAccess', () => {
    it('should return valid result when user is member of organization', async () => {
      const metadata = createMockDB({
        organizations: {
          results: [organization('org-1', 'Test Org', 'company', 'enterprise')],
        },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-1', 1)] },
      });

      const result = await validateConsentOrgAccess(
        { metadata, account },
        'user-123',
        'org-1',
        'default'
      );

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
      // The organization exists, but the user has no membership of it
      const metadata = createMockDB({
        organizations: {
          results: [organization('org-not-member', 'Other Org', 'company', 'free')],
        },
      });
      const account = createMockDB({
        memberships: { results: [] },
      });

      const result = await validateConsentOrgAccess(
        { metadata, account },
        'user-123',
        'org-not-member',
        'default'
      );

      expect(result.valid).toBe(false);
      expect(result.error).toBe('User is not a member of the specified organization');
      expect(result.organization).toBeUndefined();
    });

    it('should handle non-primary organization', async () => {
      const metadata = createMockDB({
        organizations: {
          results: [organization('org-2', 'Secondary Org', 'department', 'free')],
        },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-2', 0)] },
      });

      const result = await validateConsentOrgAccess(
        { metadata, account },
        'user-123',
        'org-2',
        'default'
      );

      expect(result.valid).toBe(true);
      expect(result.organization?.is_primary).toBe(false);
    });

    it('should return invalid result when the organization is deactivated', async () => {
      const metadata = createMockDB({
        organizations: {
          results: [organization('org-1', 'Closed Org', 'company', 'free', 0)],
        },
      });
      const account = createMockDB({
        memberships: { results: [membership('org-1', 1)] },
      });

      const result = await validateConsentOrgAccess(
        { metadata, account },
        'user-123',
        'org-1',
        'default'
      );

      expect(result.valid).toBe(false);
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
      // Global and org-1 assignments count; an assignment scoped to org-2 does not
      const metadata = createMockDB({
        roles: {
          results: [
            role('role-org-admin', 'org_admin'),
            role('role-member', 'member'),
            role('role-other', 'other_org_role'),
          ],
        },
      });
      const account = createMockDB({
        roleAssignments: {
          results: [
            assignment('role-org-admin', 'org', 'org:org-1'),
            assignment('role-member'),
            assignment('role-other', 'org', 'org:org-2'),
          ],
        },
      });

      const result = await getRolesInOrganization(
        { metadata, account },
        'user-123',
        'org-1',
        'default'
      );

      expect(result).toEqual(['member', 'org_admin']);
    });

    it('should return empty array when no roles found', async () => {
      const metadata = createMockDB({});
      const account = createMockDB({ roleAssignments: { results: [] } });

      const result = await getRolesInOrganization(
        { metadata, account },
        'user-123',
        'org-1',
        'default'
      );

      expect(result).toEqual([]);
    });

    it('should call DB with correct parameters', async () => {
      const metadata = createMockDB({ roles: { results: [role('role-1', 'org_admin')] } });
      const account = createMockDB({
        roleAssignments: { results: [assignment('role-1', 'org', 'org:org-456')] },
      });

      await getRolesInOrganization({ metadata, account }, 'user-123', 'org-456', 'default');

      // Assignments: tenant and subject on the account database
      const assignmentQuery = account.calls.find(({ sql }) =>
        sql.includes('FROM role_assignments')
      );
      expect(assignmentQuery?.params.slice(0, 2)).toEqual(['default', 'user-123']);
      // Role definitions: tenant and the assigned role ids on the metadata database
      const roleQuery = metadata.calls.find(({ sql }) => sql.includes('FROM roles'));
      expect(roleQuery?.params).toEqual(['default', 'role-1']);
      // Neither database is asked for the other's tables
      expect(account.calls.some(({ sql }) => sql.includes('FROM roles'))).toBe(false);
      expect(metadata.calls.some(({ sql }) => sql.includes('FROM role_assignments'))).toBe(false);
    });
  });
});
