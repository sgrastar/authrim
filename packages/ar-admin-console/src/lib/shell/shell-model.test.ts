import { describe, expect, it } from 'vitest';
import { persona } from '$lib/access/personas';
import type { MessageKey } from '$lib/i18n/messages/ja';
import { resolveNavPath } from './nav';
import { drawerSections, showsSubNav, subNavRows, topNavEntries } from './shell-model';

const t = (key: MessageKey) => key;

describe('shell model', () => {
	it('marks exactly one left-nav item as current', () => {
		const rows = subNavRows(resolveNavPath('/admin/users/agents')!, t);
		const active = rows.filter((row) => row.type === 'item' && row.active);
		expect(active).toHaveLength(1);
		expect(active[0]).toMatchObject({ href: '/admin/users/agents' });
	});

	it('adds a group label per area only in merged categories', () => {
		const merged = subNavRows(resolveNavPath('/admin/monitoring/audit')!, t);
		expect(merged.filter((row) => row.type === 'group').map((row) => row.label)).toEqual([
			'nav.monitoring',
			'nav.integrations'
		]);
		const single = subNavRows(resolveNavPath('/admin/users/all')!, t);
		expect(single.some((row) => row.type === 'group')).toBe(false);
	});

	it('leaves out items the admin could not use, not greyed out', () => {
		const at = resolveNavPath('/admin/authentication/methods')!;
		const hrefs = (id: Parameters<typeof persona>[0]) =>
			subNavRows(at, t, persona(id).access).map((row) => (row.type === 'item' ? row.href : ''));
		const page = '/admin/authentication/staying-signed-in';
		expect(hrefs('tenant')).toContain(page);
		expect(hrefs('viewer')).toContain(page);
		expect(hrefs('support')).not.toContain(page);
		// Items that do not state what they need yet stay for everyone.
		expect(hrefs('support')).toContain('/admin/authentication/methods');
	});

	it('has no left nav on the overview', () => {
		expect(subNavRows(resolveNavPath('/admin')!, t)).toEqual([]);
		expect(subNavRows(resolveNavPath('/admin/platform')!, t)).toEqual([]);
	});

	it('tags platform-scope items that are not plain defaults', () => {
		const rows = subNavRows(resolveNavPath('/admin/platform/users/all')!, t);
		const all = rows.find((row) => row.type === 'item' && row.key.endsWith(':all'));
		expect(all).toMatchObject({ tag: 'plat.lookup.tag', tagTone: 'lookup' });
		const tenantRows = subNavRows(resolveNavPath('/admin/users/all')!, t);
		expect(tenantRows.every((row) => row.type !== 'item' || row.tag === undefined)).toBe(true);
	});

	it('flags inherited categories only in platform scope', () => {
		expect(topNavEntries('tenant', t).some((entry) => entry.inherited)).toBe(false);
		const platform = topNavEntries('platform', t);
		expect(platform.filter((entry) => entry.inherited).map((entry) => entry.id)).toEqual([
			'users',
			'access',
			'applications',
			'configure',
			'operate'
		]);
	});

	it('gives the drawer one section per header category', () => {
		const location = resolveNavPath('/admin/access/roles')!;
		const sections = drawerSections(location, t);
		expect(sections.map((section) => section.id)).toEqual(
			topNavEntries('tenant', t).map((entry) => entry.id)
		);
		expect(sections.find((section) => section.id === 'overview')?.rows).toEqual([]);
	});

	it('gives the service flow page the whole width but keeps it in the drawer', () => {
		const flows = resolveNavPath('/admin/applications/all')!;
		expect(showsSubNav(flows)).toBe(false);
		expect(showsSubNav(resolveNavPath('/admin/users/all')!)).toBe(true);
		expect(showsSubNav(resolveNavPath('/admin/users/all')!, true)).toBe(false);
		const section = drawerSections(flows, (key) => key).find((s) => s.id === 'applications');
		expect(section?.rows.some((row) => row.type === 'item')).toBe(true);
	});
});
