import { describe, expect, it } from 'vitest';
import { canSeeNavPath, isPlatformAdminOnlyPath } from './nav-access';

const tenantAdmin = { isPlatformAdmin: false };
const platformAdmin = { isPlatformAdmin: true };

describe('left navigation access', () => {
	it.each([
		'/admin/tenants',
		'/admin/tenant-vanity-domains',
		'/admin/platform/tenant-domain-mappings',
		'/admin/control-plane',
		'/admin/scale',
		'/admin/storage-topology',
		'/admin/storage-destinations',
		'/admin/database-connections',
		'/admin/dr-backup',
		'/admin/logging-policies',
		'/admin/plugins',
		'/admin/iat-tokens'
	])('hides %s from a tenant administrator', (path) => {
		expect(canSeeNavPath(path, tenantAdmin)).toBe(false);
		expect(canSeeNavPath(path, platformAdmin)).toBe(true);
	});

	it.each([
		'/admin/users',
		'/admin/info',
		'/admin/settings',
		'/admin/clients',
		'/admin/tenant-discovery',
		'/admin/admins',
		'/admin/admin-audit',
		'/admin/audit-logs',
		'/admin/jobs'
	])('keeps %s visible to a tenant administrator', (path) => {
		expect(canSeeNavPath(path, tenantAdmin)).toBe(true);
	});

	it('matches whole path segments only', () => {
		expect(isPlatformAdminOnlyPath('/admin/tenants/acme')).toBe(true);
		expect(isPlatformAdminOnlyPath('/admin/tenant-discovery')).toBe(false);
		expect(isPlatformAdminOnlyPath('/admin/pluginsfoo')).toBe(false);
	});

	it('hides nothing before the session is known', () => {
		expect(canSeeNavPath('/admin/tenants', null)).toBe(true);
		expect(canSeeNavPath('/admin/tenants', undefined)).toBe(true);
	});
});
