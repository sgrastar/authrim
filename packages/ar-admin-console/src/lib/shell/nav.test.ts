import { describe, expect, it } from 'vitest';
import { ja } from '$lib/i18n/messages/ja';
import { ICON_PATHS } from '$lib/ui/icons/icons';
import {
	allNavHrefs,
	isStandalonePath,
	navHref,
	resolveNavPath,
	scopeNav,
	topEntryOf
} from './nav';
import { PLATFORM_AREAS, TENANT_AREAS } from './nav-data';

describe('navigation model', () => {
	it('resolves every generated link back to the same place', () => {
		const hrefs = allNavHrefs();
		expect(hrefs.length).toBeGreaterThan(80);
		for (const href of hrefs) {
			const location = resolveNavPath(href);
			expect(location, href).not.toBeNull();
			expect(navHref(location!.kind, location!.area.id, location!.item?.id), href).toBe(href);
		}
	});

	it('generates unique links', () => {
		const hrefs = allNavHrefs();
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it('uses feature names in URLs and keeps platform-only areas under /admin/platform', () => {
		expect(navHref('tenant', 'users', 'agents')).toBe('/admin/users/agents');
		expect(navHref('platform', 'plat-tenants', 'list')).toBe('/admin/platform/tenants/list');
		expect(navHref('platform', 'users', 'all')).toBe('/admin/platform/users/all');
		expect(navHref('tenant', 'overview')).toBe('/admin');
		expect(navHref('platform', 'plat-overview')).toBe('/admin/platform');
	});

	it('rejects paths the navigation does not know instead of guessing', () => {
		for (const path of [
			'/admin/nope',
			'/admin/users',
			'/admin/users/nope',
			'/admin/users/all/extra',
			'/admin/tenants/list',
			'/admin/plat-tenants/list',
			'/admin/platform/plat-tenants/list',
			'/admin/overview',
			'/elsewhere'
		]) {
			expect(resolveNavPath(path), path).toBeNull();
		}
	});

	it('maps merged categories to the category that contains them', () => {
		expect(topEntryOf('tenant', 'integrations').id).toBe('operate');
		expect(topEntryOf('platform', 'customization').id).toBe('configure');
		expect(resolveNavPath('/admin/monitoring/audit')?.top.id).toBe('operate');
	});

	it('only references existing message keys and icons', () => {
		const areas = [...TENANT_AREAS, ...PLATFORM_AREAS];
		for (const area of areas) {
			expect(ja).toHaveProperty([area.label]);
			expect(ICON_PATHS).toHaveProperty(area.icon);
			for (const item of area.children) {
				expect(ja, `${area.id}/${item.id}`).toHaveProperty([item.label]);
				expect(ICON_PATHS, `${area.id}/${item.id}`).toHaveProperty(item.icon);
			}
		}
		for (const kind of ['tenant', 'platform'] as const) {
			for (const entry of scopeNav(kind).topnav) {
				if (entry.label) expect(ja).toHaveProperty([entry.label]);
			}
		}
	});

	it('keeps every legacy Admin UI route assigned to an item', () => {
		const legacy = [...TENANT_AREAS, ...PLATFORM_AREAS].flatMap((area) => [
			...area.legacyRoutes,
			...area.children.flatMap((item) => item.legacyRoutes)
		]);
		const routes = legacy.filter((route) => route.startsWith('/admin'));
		expect(routes.length).toBeGreaterThan(100);
	});

	it('keeps personal settings outside the navigation', () => {
		expect(isStandalonePath('/admin/me')).toBe(true);
		expect(isStandalonePath('/admin/me/')).toBe(true);
		expect(isStandalonePath('/admin/users')).toBe(false);
		expect(resolveNavPath('/admin/me')).toBeNull();
		expect(allNavHrefs()).not.toContain('/admin/me');
	});
});
