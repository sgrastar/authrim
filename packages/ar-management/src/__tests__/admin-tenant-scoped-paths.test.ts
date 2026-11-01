import { describe, expect, it } from 'vitest';
import { isTenantScopedAdminPath } from '../admin-tenant-access';

/**
 * The paths that skip the system-admin guard on `/api/admin/tenants/*`. Their handlers check the
 * caller's own tenant, so the list is what decides which tenant pages a tenant Admin may open.
 */
describe('isTenantScopedAdminPath', () => {
  it.each([
    '/api/admin/tenants/tenant-a/settings/session',
    '/api/admin/tenants/tenant-a/directory-auth/policy',
    '/api/admin/tenants/tenant-a/info',
    '/api/admin/tenants/tenant-a/invitations',
    '/api/admin/tenants/tenant-a/invitations/invitation-1',
    '/api/admin/tenants/tenant-a/email-settings',
    '/api/admin/tenants/tenant-a/runtime-profiles',
  ])('keeps %s with the tenant', (path) => {
    expect(isTenantScopedAdminPath(path)).toBe(true);
  });

  it.each([
    '/api/admin/tenants',
    '/api/admin/tenants/tenant-a',
    '/api/admin/tenants/tenant-a/provisioning',
    '/api/admin/tenants/tenant-a/set-default',
    '/api/admin/tenants/tenant-a/placement-migrations',
    // A look-alike under a tenant path, or deeper than the handler's own routes, stays platform-only.
    '/api/admin/tenants/tenant-a/invitations/invitation-1/extra',
    '/api/admin/tenants/tenant-a/email-settings/extra',
    '/api/admin/tenants/tenant-a/runtime-profiles/audit/default',
    '/api/admin/tenants/tenant-a/x/invitations',
    '/api/admin/runtime-profiles',
  ])('leaves %s to platform administrators', (path) => {
    expect(isTenantScopedAdminPath(path)).toBe(false);
  });
});
