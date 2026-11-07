import { describe, expect, it } from 'vitest';
import {
	accessFromSession,
	hasPermission,
	NO_ACCESS,
	permissionLevel,
	settingsLevel,
	teamAccess,
	widest
} from './access';
import { persona } from './personas';

const platform = persona('platform').access;
const tenant = persona('tenant').access;
const support = persona('support').access;
const viewer = persona('viewer').access;

describe('permissions', () => {
	it('lets wildcards cover what is under them, as the API does', () => {
		expect(hasPermission(platform, 'admin:users:delete')).toBe(true);
		expect(hasPermission(tenant, 'admin:users:delete')).toBe(true);
		expect(hasPermission(support, 'admin:admin_users:read')).toBe(false);
		expect(hasPermission(tenant, 'admin:control_plane:read')).toBe(false);
		expect(hasPermission(NO_ACCESS, 'admin:users:read')).toBe(false);
	});

	it('gives one level for a kind of object', () => {
		const users = (a = tenant) => permissionLevel(a, 'admin:users:read', 'admin:users:write');
		expect(users(tenant)).toBe('edit');
		expect(users(support)).toBe('view');
		expect(users(NO_ACCESS)).toBe('none');
	});
});

describe('settings, as the settings API decides it for a person', () => {
	it('opens tenant settings by role: admin edits, viewer reads, support sees nothing', () => {
		expect(settingsLevel(tenant, 'session', 'tenant')).toBe('edit');
		expect(settingsLevel(viewer, 'session', 'tenant')).toBe('view');
		expect(settingsLevel(support, 'session', 'tenant')).toBe('none');
		expect(settingsLevel(platform, 'session', 'tenant')).toBe('edit');
	});

	it('does not open settings on a permission alone', () => {
		const custom = { platform: false, roles: ['custom-ops'], permissions: ['admin:settings:*'] };
		expect(settingsLevel(custom, 'oauth', 'tenant')).toBe('none');
	});

	it('keeps platform categories to platform admins, and deploy-time ones read-only', () => {
		expect(settingsLevel(tenant, 'rate-limit', 'platform')).toBe('none');
		expect(settingsLevel(platform, 'rate-limit', 'platform')).toBe('edit');
		expect(settingsLevel(platform, 'infrastructure', 'platform')).toBe('view');
		expect(settingsLevel(platform, 'encryption', 'platform')).toBe('view');
	});

	it('offers a category only at the scopes it has', () => {
		expect(settingsLevel(platform, 'ciba', 'platform')).toBe('none');
		expect(settingsLevel(platform, 'client', 'tenant')).toBe('none');
	});

	it('shows the institution of a tenant to its own admins as read-only, and lets the platform change it', () => {
		// The tenant admin edits other tenant settings, but the scopes and names of the institution
		// are the platform's to set (the API refuses a super admin role that is not held globally as well).
		expect(settingsLevel(tenant, 'session', 'tenant')).toBe('edit');
		expect(settingsLevel(tenant, 'institution', 'tenant')).toBe('view');
		expect(settingsLevel(viewer, 'institution', 'tenant')).toBe('view');
		expect(settingsLevel(support, 'institution', 'tenant')).toBe('none');
		expect(settingsLevel(platform, 'institution', 'tenant')).toBe('edit');
		const tenantSuperAdmin = { platform: false, roles: ['ar_super_admin'], permissions: ['*'] };
		expect(settingsLevel(tenantSuperAdmin, 'institution', 'tenant')).toBe('view');
		// It is a tenant category only.
		expect(settingsLevel(platform, 'institution', 'platform')).toBe('none');
	});

	it('takes the most of several parts', () => {
		expect(widest(['none', 'view'])).toBe('view');
		expect(widest(['view', 'edit', 'none'])).toBe('edit');
		expect(widest([])).toBe('none');
	});

	it('reads the session response', () => {
		const access = accessFromSession({
			roles: ['viewer'],
			permissions: ['admin:users:read'],
			is_platform_admin: false
		});
		expect(access).toEqual({
			platform: false,
			roles: ['viewer'],
			permissions: ['admin:users:read']
		});
	});
});

describe('the team pages, as the admin APIs decide them', () => {
	const none = {
		read: false,
		manage: false,
		invite: false,
		inviteForm: false,
		global: false,
		edit: false,
		delete: false,
		grant: false,
		revoke: false,
		revokeGlobal: false,
		expiry: false,
		groupsEdit: false,
		groupsGrant: false,
		roles: false,
		rolesEdit: false
	};
	const all = { ...none, read: true, manage: true, invite: true, inviteForm: true, edit: true };
	const of = (permissions: string[]) => teamAccess({ platform: false, roles: [], permissions });

	it('lets a tenant admin do everything but give roles for every tenant', () => {
		expect(teamAccess(tenant)).toEqual({
			...all,
			delete: true,
			grant: true,
			revoke: true,
			expiry: true,
			groupsEdit: true,
			groupsGrant: true,
			roles: true,
			rolesEdit: true
		});
	});

	it('lets the platform admin give roles for every tenant', () => {
		expect(teamAccess(platform).global).toBe(true);
	});

	it('needs the roles write permission too to invite or change roles', () => {
		expect(of(['admin:admin_users:*'])).toEqual({
			...none,
			read: true,
			manage: true,
			edit: true,
			delete: true
		});
	});

	it('opens the invitation form and the role grant only with the roles to offer readable', () => {
		expect(of(['admin:admin_users:*', 'admin:admin_roles:write'])).toEqual({
			...none,
			read: true,
			manage: true,
			invite: true,
			edit: true,
			delete: true,
			revoke: true,
			groupsEdit: true
		});
	});

	it('changes admin groups with the roles write permission, and gives them roles with read too', () => {
		const access = of(['admin:admin_users:read', 'admin:admin_roles:write']);
		expect(access.groupsEdit).toBe(true);
		expect(access.groupsGrant).toBe(false);
	});

	it("changes a role's end only with the roles read permission too, which the roles API asks", () => {
		expect(of(['admin:admin_users:read', 'admin:admin_roles:write']).expiry).toBe(false);
		expect(of(['admin:admin_users:read', 'admin:admin_roles:*']).expiry).toBe(true);
	});

	it('removes a role for every tenant with the roles write permission from a global assignment', () => {
		expect(teamAccess(platform).revokeGlobal).toBe(true);
		expect(teamAccess(tenant).revokeGlobal).toBe(false);
	});

	it('removes a role only with the delete permission, since it is a DELETE', () => {
		const access = of(['admin:admin_users:read', 'admin:admin_users:write', 'admin:admin_roles:*']);
		expect(access.revoke).toBe(false);
		expect(access.grant).toBe(true);
	});

	it('shows nothing to an admin without the administrators read permission', () => {
		expect(teamAccess(support)).toEqual(none);
	});
});
