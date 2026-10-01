/**
 * Turns the navigation model plus the current location into what the shell renders.
 * Pure (translation is passed in) so it can be unit-tested and reused by stories.
 */
import type { AdminAccess } from '$lib/access/access';
import type { MessageKey } from '$lib/i18n/messages/ja';
import type { IconName } from '$lib/ui/icons/icons';
import {
	areasOfTop,
	landingAreaOf,
	navHref,
	scopeNav,
	type NavLocation,
	type ScopeKind,
	type TopEntry
} from './nav';
import { visibleItems } from './nav-access';
import type { PlatformTreatment } from './nav-types';
import { scopeColor } from './scope-color';
import type { SubNavRow } from './SubNav.svelte';
import type { TopNavEntry } from './TopNav.svelte';

export type Translate = (key: MessageKey) => string;

function topLabel(kind: ScopeKind, entry: TopEntry): MessageKey {
	return entry.label ?? scopeNav(kind).byId.get(entry.id)?.label ?? 'nav.overview';
}

function topIcon(kind: ScopeKind, entry: TopEntry): IconName {
	return entry.icon ?? scopeNav(kind).byId.get(entry.id)?.icon ?? 'gauge';
}

function topColor(kind: ScopeKind, entry: TopEntry): string {
	return scopeColor(entry.scope ?? scopeNav(kind).byId.get(entry.id)?.scope);
}

export function topNavEntries(kind: ScopeKind, t: Translate): TopNavEntry[] {
	return scopeNav(kind).topnav.map((entry) => ({
		id: entry.id,
		label: t(topLabel(kind, entry)),
		icon: topIcon(kind, entry),
		href: navHref(kind, landingAreaOf(entry)),
		color: topColor(kind, entry),
		inherited: kind === 'platform' && entry.inherited === true,
		badge: scopeNav(kind).byId.get(entry.id)?.badge
	}));
}

const TAG_KEY: Record<Exclude<PlatformTreatment, 'inherit'>, MessageKey> = {
	lookup: 'plat.lookup.tag',
	tenant: 'plat.tenant.tag',
	template: 'plat.template.tag'
};

/**
 * Left-nav rows for the category that contains the current location. With `access`, items the
 * admin could not use are left out (and an area left empty goes with them).
 */
export function subNavRows(location: NavLocation, t: Translate, access?: AdminAccess): SubNavRow[] {
	const { kind, top } = location;
	const areas = areasOfTop(kind, top);
	if (areas.length === 0) return [];
	const rows: SubNavRow[] = [
		{ type: 'scope', key: `scope:${top.id}`, label: t(topLabel(kind, top)) }
	];
	const merged = (top.merges?.length ?? 0) > 1;
	for (const area of areas) {
		const items = visibleItems(area.children, access, kind);
		if (items.length === 0) continue;
		if (merged) rows.push({ type: 'group', key: `group:${area.id}`, label: t(area.label) });
		for (const item of items) {
			const treatment = kind === 'platform' ? (item.platform ?? 'inherit') : 'inherit';
			rows.push({
				type: 'item',
				key: `item:${area.id}:${item.id}`,
				label: t(item.label),
				icon: item.icon,
				href: navHref(kind, area.id, item.id),
				active: location.area.id === area.id && location.item?.id === item.id,
				tag: treatment === 'inherit' ? undefined : t(TAG_KEY[treatment]),
				tagTone: treatment === 'inherit' ? undefined : treatment,
				badge: item.badge
			});
		}
	}
	return rows;
}

export interface DrawerSection {
	id: string;
	label: string;
	icon: IconName;
	href: string;
	rows: SubNavRow[];
}

/** Phone navigation: every category, each expandable to its items. */
export function drawerSections(
	location: NavLocation,
	t: Translate,
	access?: AdminAccess
): DrawerSection[] {
	const { kind } = location;
	return scopeNav(kind).topnav.map((entry) => ({
		id: entry.id,
		label: t(topLabel(kind, entry)),
		icon: topIcon(kind, entry),
		href: navHref(kind, landingAreaOf(entry)),
		rows: subNavRows({ ...location, top: entry }, t, access).filter((row) => row.type !== 'scope')
	}));
}

/** Whether the left nav is shown: not on pages outside the nav or pages that own the column. */
export function showsSubNav(location: NavLocation, standalone = false): boolean {
	return !standalone && location.item?.ownsSide !== true;
}

export function areaColor(location: NavLocation): string {
	return topColor(location.kind, location.top);
}
