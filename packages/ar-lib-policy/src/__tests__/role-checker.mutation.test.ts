import { describe, expect, it, vi } from 'vitest';
import {
  getActiveRoles,
  hasAllRoles,
  hasAnyRole,
  hasRole,
  isAdmin,
  subjectFromClaims,
} from '../role-checker';
import type { SubjectRole } from '../types';

const NOW = 1_000_000;

describe('hasRole', () => {
  it('reads roles from a list or from a subject', () => {
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
    expect(hasRole(roles, 'admin')).toBe(true);
    expect(hasRole({ id: 'u', roles }, 'admin')).toBe(true);
    expect(hasRole(roles, 'other')).toBe(false);
    expect(hasRole([], 'admin')).toBe(false);
  });

  it('ends a role at its expiry, exactly', () => {
    const until = (expiresAt: number): SubjectRole[] => [
      { name: 'admin', scope: 'global', expiresAt },
    ];
    expect(hasRole(until(NOW + 1), 'admin', { now: NOW })).toBe(true);
    expect(hasRole(until(NOW), 'admin', { now: NOW })).toBe(false);
    expect(hasRole(until(NOW - 1), 'admin', { now: NOW })).toBe(false);
  });

  it('uses the current time unless one is given', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      const until = (expiresAt: number): SubjectRole[] => [
        { name: 'admin', scope: 'global', expiresAt },
      ];
      expect(hasRole(until(NOW + 1), 'admin')).toBe(true);
      expect(hasRole(until(NOW), 'admin')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a global role satisfy any scope', () => {
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'global' }];
    expect(hasRole(roles, 'admin', { scope: 'org', scopeTarget: 'org:1' })).toBe(true);
    expect(hasRole(roles, 'admin', { scope: 'resource' })).toBe(true);
  });

  it('matches a scoped role on its scope, and on its target when one is asked for', () => {
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'org', scopeTarget: 'org:1' }];
    expect(hasRole(roles, 'admin', { scope: 'org' })).toBe(true);
    expect(hasRole(roles, 'admin', { scope: 'org', scopeTarget: 'org:1' })).toBe(true);
    expect(hasRole(roles, 'admin', { scope: 'org', scopeTarget: 'org:2' })).toBe(false);
    expect(hasRole(roles, 'admin', { scope: 'resource' })).toBe(false);
    expect(hasRole(roles, 'admin')).toBe(false);
    expect(hasRole(roles, 'admin', { scope: 'global' })).toBe(false);
  });

  it('does not count a scoped role without a target for a targeted request', () => {
    const roles: SubjectRole[] = [{ name: 'admin', scope: 'org' }];
    expect(hasRole(roles, 'admin', { scope: 'org', scopeTarget: 'org:1' })).toBe(false);
    expect(hasRole(roles, 'admin', { scope: 'org' })).toBe(true);
  });
});

describe('hasAnyRole and hasAllRoles', () => {
  const roles: SubjectRole[] = [
    { name: 'a', scope: 'global' },
    { name: 'b', scope: 'org', scopeTarget: 'org:1' },
  ];

  it('any needs one of the roles', () => {
    expect(hasAnyRole(roles, ['x', 'a'])).toBe(true);
    expect(hasAnyRole(roles, ['x', 'y'])).toBe(false);
    expect(hasAnyRole(roles, [])).toBe(false);
    expect(hasAnyRole(roles, ['b'], { scope: 'org', scopeTarget: 'org:1' })).toBe(true);
    expect(hasAnyRole(roles, ['b'])).toBe(false);
  });

  it('all needs every one of the roles', () => {
    expect(hasAllRoles(roles, ['a'])).toBe(true);
    expect(hasAllRoles(roles, ['a', 'x'])).toBe(false);
    expect(hasAllRoles(roles, ['a', 'b'], { scope: 'org' })).toBe(true);
    expect(hasAllRoles(roles, ['a', 'b'])).toBe(false);
    expect(hasAllRoles(roles, [])).toBe(true);
  });
});

describe('isAdmin', () => {
  it('needs the admin role', () => {
    expect(isAdmin([{ name: 'admin', scope: 'global' }])).toBe(true);
    expect(isAdmin([{ name: 'admin', scope: 'org', scopeTarget: 'org:1' }])).toBe(false);
    expect(isAdmin([{ name: 'end_user', scope: 'global' }])).toBe(false);
    expect(isAdmin({ id: 'u', roles: [{ name: 'admin', scope: 'global' }] })).toBe(true);
  });
});

describe('getActiveRoles', () => {
  const roles: SubjectRole[] = [
    { name: 'global_role', scope: 'global' },
    { name: 'org_role', scope: 'org', scopeTarget: 'org:1' },
    { name: 'org_role_2', scope: 'org', scopeTarget: 'org:2' },
    { name: 'resource_role', scope: 'resource', scopeTarget: 'resource:r' },
    { name: 'expired', scope: 'global', expiresAt: NOW },
    { name: 'global_role', scope: 'org', scopeTarget: 'org:1' },
  ];

  it('lists every live role once, in order, when no scope is asked for', () => {
    expect(getActiveRoles(roles, { now: NOW })).toEqual([
      'global_role',
      'org_role',
      'org_role_2',
      'resource_role',
    ]);
    expect(getActiveRoles({ id: 'u', roles }, { now: NOW })).toHaveLength(4);
  });

  it('keeps global roles and those of the asked scope', () => {
    expect(getActiveRoles(roles, { now: NOW, scope: 'org' })).toEqual([
      'global_role',
      'org_role',
      'org_role_2',
    ]);
    expect(getActiveRoles(roles, { now: NOW, scope: 'resource' })).toEqual([
      'global_role',
      'resource_role',
    ]);
    expect(getActiveRoles(roles, { now: NOW, scope: 'global' })).toEqual(['global_role']);
  });

  it('keeps global roles and those of the asked target', () => {
    expect(getActiveRoles(roles, { now: NOW, scope: 'org', scopeTarget: 'org:1' })).toEqual([
      'global_role',
      'org_role',
    ]);
    expect(getActiveRoles(roles, { now: NOW, scope: 'org', scopeTarget: 'org:9' })).toEqual([
      'global_role',
    ]);
  });

  it('ignores a target when no scope is asked for', () => {
    expect(getActiveRoles(roles, { now: NOW, scopeTarget: 'org:9' })).toHaveLength(4);
  });

  it('ends a role at its expiry, exactly, and reads the current time by default', () => {
    const until = (expiresAt: number): SubjectRole[] => [{ name: 'r', scope: 'global', expiresAt }];
    expect(getActiveRoles(until(NOW + 1), { now: NOW })).toEqual(['r']);
    expect(getActiveRoles(until(NOW), { now: NOW })).toEqual([]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(NOW));
      expect(getActiveRoles(until(NOW + 1))).toEqual(['r']);
      expect(getActiveRoles(until(NOW))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('subjectFromClaims', () => {
  it('makes a subject of global roles from the token claims', () => {
    expect(
      subjectFromClaims({
        sub: 'user_1',
        authrim_roles: ['end_user', 'billing'],
        authrim_user_type: 'end_user',
        authrim_org_id: 'org_1',
        authrim_plan: 'professional',
        authrim_org_type: 'enterprise',
      })
    ).toStrictEqual({
      id: 'user_1',
      userType: 'end_user',
      roles: [
        { name: 'end_user', scope: 'global' },
        { name: 'billing', scope: 'global' },
      ],
      orgId: 'org_1',
      plan: 'professional',
      orgType: 'enterprise',
    });
  });

  it('defaults to an empty id and no roles', () => {
    expect(subjectFromClaims({})).toStrictEqual({
      id: '',
      userType: undefined,
      roles: [],
      orgId: undefined,
      plan: undefined,
      orgType: undefined,
    });
  });
});
