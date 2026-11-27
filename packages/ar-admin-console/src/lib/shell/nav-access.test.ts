import { describe, expect, it } from 'vitest';
import { persona } from '#lib/access/personas.js';
import type { AdminAccess } from '#lib/access/access.js';
import { navItemLevel, visibleItems } from './nav-access';
import { TENANT_AREAS } from './nav-data';
import type { NavItem } from './nav-types';

const tenant = persona('tenant').access;

const item = (id: string, requires?: NavItem['requires']): NavItem => ({
	id,
	label: 'nav.int.plugins',
	requires
});

describe('navigation items of a capability the platform can turn off', () => {
	const webhooks = item('webhooks', { capability: 'webhooks' });
	const guarded = item('webhooks-guarded', {
		capability: 'webhooks',
		permission: 'admin:webhooks:read'
	});
	const open = item('open', { permission: 'admin:users:read' });
	const items = [webhooks, guarded, open];

	it('shows them while the capability is on', () => {
		expect(visibleItems(items, tenant, 'tenant').map((entry) => entry.id)).toEqual([
			'webhooks',
			'webhooks-guarded',
			'open'
		]);
	});

	it('leaves them out (not greyed out) while it is off, and nothing else', () => {
		const off: AdminAccess = { ...tenant, disabledCapabilities: ['webhooks'] };
		expect(visibleItems(items, off, 'tenant').map((entry) => entry.id)).toEqual(['open']);
		expect(navItemLevel(webhooks, off, 'tenant')).toBe('none');
		// Another capability being off changes nothing here.
		const other: AdminAccess = { ...tenant, disabledCapabilities: ['bulk_jobs'] };
		expect(navItemLevel(webhooks, other, 'tenant')).toBe('edit');
	});

	it('does not read an item with a permission as visible when the permission is missing', () => {
		const noPermission: AdminAccess = { ...tenant, permissions: [] };
		expect(navItemLevel(guarded, noPermission, 'tenant')).toBe('none');
	});
});

describe('navigation items any of several permissions opens', () => {
	const check = item('access-check', {
		anyPermission: ['admin:roles:read', 'admin:groups:read']
	});
	const only = (permission: string): AdminAccess => ({
		platform: false,
		roles: [],
		permissions: [permission]
	});

	it('shows them with either permission, as the page does', () => {
		expect(navItemLevel(check, only('admin:roles:read'), 'tenant')).toBe('view');
		expect(navItemLevel(check, only('admin:groups:read'), 'tenant')).toBe('view');
	});

	it('leaves them out with neither', () => {
		expect(navItemLevel(check, only('admin:users:read'), 'tenant')).toBe('none');
	});
});

describe('the policies and attributes items of Access', () => {
	const access = TENANT_AREAS.find((area) => area.id === 'access');
	const policies = access?.children.find((child) => child.id === 'policies');
	const only = (permission: string): AdminAccess => ({
		platform: false,
		roles: [],
		permissions: [permission]
	});

	it('open with the roles’ read permission, as the policies API asks', () => {
		expect(policies?.requires).toEqual({ permission: 'admin:roles:read' });
		expect(policies && navItemLevel(policies, only('admin:roles:read'), 'tenant')).toBe('view');
		expect(policies && navItemLevel(policies, only('admin:groups:read'), 'tenant')).toBe('none');
		expect(policies && navItemLevel(policies, tenant, 'tenant')).not.toBe('none');
		// A policy's own page (…/policies/<id>) belongs to the item.
		expect(policies?.details).toBe(true);
	});

	it('no longer list an attributes item: its switch is on Settings → Authorization', () => {
		expect(access?.children.some((child) => child.id === 'attributes')).toBe(false);
	});
});
