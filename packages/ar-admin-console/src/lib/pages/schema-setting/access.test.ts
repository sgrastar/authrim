import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '@authrim/ar-lib-core/constants/admin-roles';
import type { AdminAccess } from '$lib/access/access';
import { PERSONAS } from '$lib/access/personas';
import { schemaLevel } from './access';

const who = (roles: string[], permissions: string[]): AdminAccess => ({
	platform: false,
	roles,
	permissions
});

describe('who may use the attribute schema', () => {
	it('needs a tenant-admin role and the settings permission', () => {
		const tenantAdmin = [ADMIN_ROLES.TENANT_ADMIN];
		expect(schemaLevel(who(tenantAdmin, ['admin:settings:write']))).toBe('edit');
		expect(schemaLevel(who(tenantAdmin, ['admin:settings:read']))).toBe('view');
		expect(schemaLevel(who(tenantAdmin, ['admin:users:read']))).toBe('none');
	});

	it('refuses a custom role that has the permission but none of the roles', () => {
		expect(schemaLevel(who(['auditor'], ['admin:settings:write']))).toBe('none');
	});

	it('refuses the retired role names, whatever permissions they carry', () => {
		for (const retired of ['admin', 'tenant_admin', 'system_admin', 'super_admin']) {
			expect(schemaLevel(who([retired], ['*']))).toBe('none');
		}
	});

	it('lets the platform admin through, and everything with "*"', () => {
		expect(schemaLevel(who([ADMIN_ROLES.SUPER_ADMIN], ['*']))).toBe('edit');
		expect(schemaLevel(who([ADMIN_ROLES.SUPER_ADMIN], ['admin:settings:read']))).toBe('view');
	});

	it('gives each built-in role what the API gives it', () => {
		const level = Object.fromEntries(
			PERSONAS.map((persona) => [persona.id, schemaLevel(persona.access)])
		);
		// support and viewer hold (or may hold) a settings read, but the route's role gate refuses them.
		expect(level).toEqual({ platform: 'edit', tenant: 'edit', support: 'none', viewer: 'none' });
	});
});
