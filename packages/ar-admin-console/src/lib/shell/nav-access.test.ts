import { describe, expect, it } from 'vitest';
import { persona } from '#lib/access/personas.js';
import type { AdminAccess } from '#lib/access/access.js';
import { navItemLevel, visibleItems } from './nav-access';
import type { NavItem } from './nav-types';

const tenant = persona('tenant').access;

const item = (id: string, requires?: NavItem['requires']): NavItem => ({
	id,
	label: 'nav.int.plugins',
	icon: 'plug',
	requires,
	legacyRoutes: []
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
