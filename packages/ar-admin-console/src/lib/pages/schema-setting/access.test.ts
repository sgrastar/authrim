import { describe, expect, it } from 'vitest';
import type { AdminAccess } from '$lib/access/access';
import { schemaLevel } from './access';

const who = (roles: string[], permissions: string[]): AdminAccess => ({
	platform: false,
	roles,
	permissions
});

describe('who may use the attribute schema', () => {
	it('needs a tenant-admin role and the settings permission', () => {
		expect(schemaLevel(who(['tenant_admin'], ['admin:settings:write']))).toBe('edit');
		expect(schemaLevel(who(['tenant_admin'], ['admin:settings:read']))).toBe('view');
		expect(schemaLevel(who(['tenant_admin'], ['admin:users:read']))).toBe('none');
	});

	it('refuses a custom role that has the permission but none of the roles', () => {
		expect(schemaLevel(who(['auditor'], ['admin:settings:write']))).toBe('none');
	});

	it('refuses the plain admin role, which the route\u2019s role gate does not list', () => {
		expect(schemaLevel(who(['admin'], ['admin:settings:write']))).toBe('none');
	});

	it('lets the platform roles through, and everything with "*"', () => {
		expect(schemaLevel(who(['super_admin'], ['*']))).toBe('edit');
		expect(schemaLevel(who(['system_admin'], ['admin:settings:read']))).toBe('view');
	});
});
