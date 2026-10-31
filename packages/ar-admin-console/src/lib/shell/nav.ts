/**
 * Navigation model: resolves URLs to areas/items and back.
 *
 * URL rule (names follow the feature, not the legacy Admin UI routes):
 *   tenant scope    /admin/<area>/<item>             e.g. /admin/users/agents
 *   platform scope  /admin/platform/<area>/<item>    e.g. /admin/platform/tenants/list
 *   overview        /admin  and  /admin/platform
 * Platform-only areas drop their `plat-` id prefix in the URL.
 */
import { PLATFORM_AREAS, PLATFORM_TOPNAV, TENANT_AREAS, TENANT_TOPNAV } from './nav-data';
import type { NavArea, NavItem, ScopeKind, TopEntry } from './nav-types';

export type { NavArea, NavItem, ScopeKind, TopEntry } from './nav-types';

export interface ScopeNav {
	kind: ScopeKind;
	topnav: readonly TopEntry[];
	/** Every area reachable in this scope, including inherited tenant areas in platform scope. */
	areas: readonly NavArea[];
	byId: ReadonlyMap<string, NavArea>;
}

const TENANT_BY_ID = new Map(TENANT_AREAS.map((a) => [a.id, a]));
const PLATFORM_BY_ID = new Map<string, NavArea>([
	...TENANT_AREAS.map((a) => [a.id, a] as const),
	...PLATFORM_AREAS.map((a) => [a.id, a] as const)
]);

const TENANT_NAV: ScopeNav = {
	kind: 'tenant',
	topnav: TENANT_TOPNAV,
	areas: TENANT_AREAS,
	byId: TENANT_BY_ID
};

const PLATFORM_NAV: ScopeNav = {
	kind: 'platform',
	topnav: PLATFORM_TOPNAV,
	areas: PLATFORM_TOPNAV.flatMap((e) => e.merges ?? [e.id])
		.map((id) => PLATFORM_BY_ID.get(id))
		.filter((a): a is NavArea => a !== undefined),
	byId: PLATFORM_BY_ID
};

export function scopeNav(kind: ScopeKind): ScopeNav {
	return kind === 'platform' ? PLATFORM_NAV : TENANT_NAV;
}

const OVERVIEW_ID: Record<ScopeKind, string> = { tenant: 'overview', platform: 'plat-overview' };
const PLATFORM_PREFIX = 'plat-';

function areaSegment(areaId: string): string {
	return areaId.startsWith(PLATFORM_PREFIX) ? areaId.slice(PLATFORM_PREFIX.length) : areaId;
}

function scopeRoot(kind: ScopeKind): string {
	return kind === 'platform' ? '/admin/platform' : '/admin';
}

/** URL of an area (its first item) or of a specific item. */
export function navHref(kind: ScopeKind, areaId: string, itemId?: string): string {
	const nav = scopeNav(kind);
	const area = nav.byId.get(areaId);
	if (!area || areaId === OVERVIEW_ID[kind]) return scopeRoot(kind);
	const item = itemId ?? area.children[0]?.id;
	const base = `${scopeRoot(kind)}/${areaSegment(areaId)}`;
	return item ? `${base}/${item}` : base;
}

export interface NavLocation {
	kind: ScopeKind;
	area: NavArea;
	item: NavItem | null;
	top: TopEntry;
}

/** The header category an area belongs to (handles merged categories). */
export function topEntryOf(kind: ScopeKind, areaId: string): TopEntry {
	const nav = scopeNav(kind);
	return (
		nav.topnav.find((e) => e.id === areaId) ??
		nav.topnav.find((e) => e.merges?.includes(areaId)) ??
		nav.topnav[0]
	);
}

/**
 * Resolves a pathname to a location. Returns null for paths the navigation does not know,
 * which the route turns into a 404 rather than guessing a nearby page.
 */
export function resolveNavPath(pathname: string): NavLocation | null {
	const trimmed = pathname.replace(/\/+$/, '') || '/';
	const segments = trimmed.split('/').filter(Boolean);
	if (segments[0] !== 'admin') return null;
	const kind: ScopeKind = segments[1] === 'platform' ? 'platform' : 'tenant';
	const rest = segments.slice(kind === 'platform' ? 2 : 1);
	const nav = scopeNav(kind);

	if (rest.length === 0) {
		const area = nav.byId.get(OVERVIEW_ID[kind]);
		return area ? { kind, area, item: null, top: topEntryOf(kind, area.id) } : null;
	}
	if (rest.length > 2) return null;

	const [segment, itemId] = rest;
	const area =
		(kind === 'platform' ? nav.byId.get(`${PLATFORM_PREFIX}${segment}`) : undefined) ??
		(segment.startsWith(PLATFORM_PREFIX) ? undefined : nav.byId.get(segment));
	if (!area || !nav.areas.includes(area) || area.id === OVERVIEW_ID[kind]) return null;

	if (itemId === undefined) {
		return area.children.length === 0
			? { kind, area, item: null, top: topEntryOf(kind, area.id) }
			: null;
	}
	const item = area.children.find((c) => c.id === itemId) ?? null;
	return item ? { kind, area, item, top: topEntryOf(kind, area.id) } : null;
}

/** Pages that live outside the navigation (reached from the account menu). */
const STANDALONE_PATHS: ReadonlySet<string> = new Set(['/admin/me']);

export function isStandalonePath(pathname: string): boolean {
	return STANDALONE_PATHS.has(pathname.replace(/\/+$/, '') || '/');
}

/** Areas listed in the left nav for a header category, in display order. */
export function areasOfTop(kind: ScopeKind, top: TopEntry): NavArea[] {
	const nav = scopeNav(kind);
	return (top.merges ?? [top.id])
		.map((id) => nav.byId.get(id))
		.filter((a): a is NavArea => a !== undefined && a.children.length > 0);
}

/** The landing area of a header category (first merged area, or the category itself). */
export function landingAreaOf(top: TopEntry): string {
	return top.merges?.[0] ?? top.id;
}

/** Every URL the navigation can produce. Used by tests to keep links and routes in sync. */
export function allNavHrefs(): string[] {
	const hrefs = new Set<string>();
	for (const kind of ['tenant', 'platform'] as const) {
		for (const area of scopeNav(kind).areas) {
			if (area.children.length === 0) hrefs.add(navHref(kind, area.id));
			for (const item of area.children) hrefs.add(navHref(kind, area.id, item.id));
		}
	}
	return [...hrefs];
}
