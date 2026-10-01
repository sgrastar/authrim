/**
 * Whether the admin sees a navigation item. An item states what its page needs (`requires`);
 * an item the admin could not use at all is left out of the navigation, not greyed out.
 * Items without `requires` (pages not rebuilt yet) are shown to everyone.
 */
import type { CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
import {
	hasPermission,
	settingsLevel,
	widest,
	type AccessLevel,
	type AdminAccess
} from '$lib/access/access';
import type { NavItem, ScopeKind } from './nav-types';

export interface NavRequirement {
	/** Settings categories the page shows; seeing any of them is enough. */
	settings?: readonly CategoryName[];
	/** A permission the page needs (`admin:users:read`). */
	permission?: string;
}

export function navItemLevel(item: NavItem, access: AdminAccess, kind: ScopeKind): AccessLevel {
	const requires = item.requires;
	if (!requires) return 'edit';
	// In platform scope, a per-tenant item stays listed (its page explains where to set it)
	// for anyone who can use it in a tenant.
	const scope = kind === 'platform' && item.platform !== 'tenant' ? 'platform' : 'tenant';
	const levels: AccessLevel[] = [
		...(requires.settings ?? []).map((category) => settingsLevel(access, category, scope)),
		...(requires.permission ? [hasPermission(access, requires.permission) ? 'view' : 'none'] : [])
	] as AccessLevel[];
	return widest(levels);
}

export function visibleItems(
	items: readonly NavItem[],
	access: AdminAccess | undefined,
	kind: ScopeKind
): NavItem[] {
	return access ? items.filter((item) => navItemLevel(item, access, kind) !== 'none') : [...items];
}
