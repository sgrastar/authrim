import { describe, expect, it } from 'vitest';
import {
	accessFromSession,
	hasPermission,
	NO_ACCESS,
	permissionLevel,
	settingsLevel,
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
		expect(hasPermission(tenant, 'admin:admin_users:read')).toBe(false);
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
		expect(settingsLevel(platform, 'session', 'platform')).toBe('none');
		expect(settingsLevel(platform, 'client', 'tenant')).toBe('none');
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
