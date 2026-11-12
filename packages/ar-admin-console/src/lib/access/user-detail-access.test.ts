import { describe, expect, it } from 'vitest';
import { userDetailAccess } from './access';
import { persona } from './personas';

describe('what an admin may do on a user page', () => {
	it('gives a tenant administrator everything', () => {
		expect(userDetailAccess(persona('tenant').access)).toEqual({
			read: true,
			edit: true,
			lifecycle: true,
			delete: true,
			sessions: true,
			revokeSessions: true
		});
	});

	it('lets support read and edit but not change the state or delete', () => {
		const access = userDetailAccess(persona('support').access);
		expect(access.read).toBe(true);
		expect(access.lifecycle).toBe(false);
		expect(access.delete).toBe(false);
	});

	it('leaves a viewer with reading only', () => {
		const access = userDetailAccess(persona('viewer').access);
		expect(access).toMatchObject({ read: true, edit: false, lifecycle: false, delete: false });
		expect(access.revokeSessions).toBe(false);
	});

	it('asks for the tenant administrator role as well as write permission', () => {
		const custom = {
			platform: false,
			roles: ['custom'],
			permissions: ['admin:users:read', 'admin:users:write']
		};
		expect(userDetailAccess(custom)).toMatchObject({ edit: true, lifecycle: false });
		expect(userDetailAccess({ ...custom, roles: ['ar_tenant_admin'] }).lifecycle).toBe(true);
	});

	it('shows nothing without read permission', () => {
		expect(
			userDetailAccess({
				platform: false,
				roles: ['ar_tenant_admin'],
				permissions: ['admin:users:write']
			})
		).toMatchObject({ read: false, edit: false, lifecycle: false });
	});

	it('needs the sessions permissions for the sessions parts', () => {
		const access = userDetailAccess({
			platform: false,
			roles: [],
			permissions: ['admin:users:read', 'admin:sessions:read']
		});
		expect(access).toMatchObject({ sessions: true, revokeSessions: false });
	});
});
