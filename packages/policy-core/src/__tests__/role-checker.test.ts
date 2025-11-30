/**
 * Role Checker Unit Tests
 */

import { describe, it, expect } from 'vitest';
import {
  hasRole,
  hasAnyRole,
  hasAllRoles,
  isAdmin,
  isSystemAdmin,
  isOrgAdmin,
  getActiveRoles,
  subjectFromClaims,
} from '../role-checker';
import type { SubjectRole, PolicySubject } from '../types';

describe('role-checker', () => {
  describe('hasRole', () => {
    it('should return true when subject has the role', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(hasRole(roles, 'admin')).toBe(true);
    });

    it('should return false when subject does not have the role', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(hasRole(roles, 'super_admin')).toBe(false);
    });

    it('should return false for expired roles', () => {
      const expiredTime = Date.now() - 1000;
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global', expiresAt: expiredTime }];
      expect(hasRole(roles, 'admin')).toBe(false);
    });

    it('should return true for non-expired roles', () => {
      const futureTime = Date.now() + 100000;
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global', expiresAt: futureTime }];
      expect(hasRole(roles, 'admin')).toBe(true);
    });

    it('should handle global scope matching any requirement', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(hasRole(roles, 'admin', { scope: 'organization' })).toBe(true);
    });

    it('should handle scoped role matching', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'org', scopeTarget: 'org:123' }];
      expect(hasRole(roles, 'org_admin', { scope: 'org', scopeTarget: 'org:123' })).toBe(true);
      expect(hasRole(roles, 'org_admin', { scope: 'org', scopeTarget: 'org:456' })).toBe(false);
    });

    it('should accept PolicySubject as input', () => {
      const subject: PolicySubject = {
        id: 'user_1',
        roles: [{ name: 'admin', scope: 'global' }],
      };
      expect(hasRole(subject, 'admin')).toBe(true);
    });
  });

  describe('hasAnyRole', () => {
    it('should return true when subject has any of the roles', () => {
      const roles: SubjectRole[] = [{ name: 'editor', scope: 'global' }];
      expect(hasAnyRole(roles, ['admin', 'editor', 'viewer'])).toBe(true);
    });

    it('should return false when subject has none of the roles', () => {
      const roles: SubjectRole[] = [{ name: 'guest', scope: 'global' }];
      expect(hasAnyRole(roles, ['admin', 'editor'])).toBe(false);
    });

    it('should return true when subject has multiple matching roles', () => {
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'editor', scope: 'global' },
      ];
      expect(hasAnyRole(roles, ['admin', 'editor'])).toBe(true);
    });
  });

  describe('hasAllRoles', () => {
    it('should return true when subject has all roles', () => {
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'editor', scope: 'global' },
      ];
      expect(hasAllRoles(roles, ['admin', 'editor'])).toBe(true);
    });

    it('should return false when subject is missing a role', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(hasAllRoles(roles, ['admin', 'editor'])).toBe(false);
    });

    it('should return true for empty role list', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(hasAllRoles(roles, [])).toBe(true);
    });
  });

  describe('isAdmin', () => {
    it('should return true for system_admin', () => {
      const roles: SubjectRole[] = [{ name: 'system_admin', scope: 'global' }];
      expect(isAdmin(roles)).toBe(true);
    });

    it('should return true for distributor_admin', () => {
      const roles: SubjectRole[] = [{ name: 'distributor_admin', scope: 'global' }];
      expect(isAdmin(roles)).toBe(true);
    });

    it('should return true for org_admin', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'global' }];
      expect(isAdmin(roles)).toBe(true);
    });

    it('should return true for admin', () => {
      const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
      expect(isAdmin(roles)).toBe(true);
    });

    it('should return false for non-admin roles', () => {
      const roles: SubjectRole[] = [{ name: 'end_user', scope: 'global' }];
      expect(isAdmin(roles)).toBe(false);
    });
  });

  describe('isSystemAdmin', () => {
    it('should return true for system_admin', () => {
      const roles: SubjectRole[] = [{ name: 'system_admin', scope: 'global' }];
      expect(isSystemAdmin(roles)).toBe(true);
    });

    it('should return false for other admin types', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'global' }];
      expect(isSystemAdmin(roles)).toBe(false);
    });
  });

  describe('isOrgAdmin', () => {
    it('should return true for org_admin without org check', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'global' }];
      expect(isOrgAdmin(roles)).toBe(true);
    });

    it('should return true for scoped org_admin with matching org', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'org', scopeTarget: 'org:123' }];
      expect(isOrgAdmin(roles, '123')).toBe(true);
    });

    it('should return false for scoped org_admin with non-matching org', () => {
      const roles: SubjectRole[] = [{ name: 'org_admin', scope: 'org', scopeTarget: 'org:123' }];
      expect(isOrgAdmin(roles, '456')).toBe(false);
    });
  });

  describe('getActiveRoles', () => {
    it('should return all active role names', () => {
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'editor', scope: 'global' },
      ];
      expect(getActiveRoles(roles)).toEqual(['admin', 'editor']);
    });

    it('should exclude expired roles', () => {
      const expiredTime = Date.now() - 1000;
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'editor', scope: 'global', expiresAt: expiredTime },
      ];
      expect(getActiveRoles(roles)).toEqual(['admin']);
    });

    it('should return unique role names', () => {
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'admin', scope: 'org', scopeTarget: 'org:123' },
      ];
      expect(getActiveRoles(roles)).toEqual(['admin']);
    });

    it('should filter by scope when specified', () => {
      const roles: SubjectRole[] = [
        { name: 'admin', scope: 'global' },
        { name: 'org_admin', scope: 'org', scopeTarget: 'org:123' },
      ];
      expect(getActiveRoles(roles, { scope: 'org' })).toEqual(['admin', 'org_admin']);
    });
  });

  describe('subjectFromClaims', () => {
    it('should create PolicySubject from token claims', () => {
      const claims = {
        sub: 'user_123',
        authrim_roles: ['admin', 'editor'],
        authrim_user_type: 'enterprise_admin',
        authrim_org_id: 'org_456',
        authrim_plan: 'professional',
        authrim_org_type: 'enterprise',
      };

      const subject = subjectFromClaims(claims);

      expect(subject.id).toBe('user_123');
      expect(subject.roles).toHaveLength(2);
      expect(subject.roles[0]).toEqual({ name: 'admin', scope: 'global' });
      expect(subject.roles[1]).toEqual({ name: 'editor', scope: 'global' });
      expect(subject.userType).toBe('enterprise_admin');
      expect(subject.orgId).toBe('org_456');
      expect(subject.plan).toBe('professional');
      expect(subject.orgType).toBe('enterprise');
    });

    it('should handle missing claims', () => {
      const claims = {};
      const subject = subjectFromClaims(claims);

      expect(subject.id).toBe('');
      expect(subject.roles).toEqual([]);
      expect(subject.userType).toBeUndefined();
      expect(subject.orgId).toBeUndefined();
    });
  });
});
