import type { MessageKey } from '$lib/i18n/messages/ja';
import type { IconName } from '$lib/ui/icons/icons';
import type { NavRequirement } from './nav-access';

/** Which kind of subject an area manages. Drives the accent colour of the category. */
export type AreaScope = 'enduser' | 'client' | 'tenant' | 'platform';

/**
 * How an item behaves when opened in platform scope.
 * - inherit  : the value set here is the default for every tenant (default)
 * - lookup   : cross-tenant search, not a setting
 * - tenant   : cannot be set at platform level; switch to a tenant
 * - template : shares a definition while tenant-specific values stay in each tenant
 */
export type PlatformTreatment = 'inherit' | 'lookup' | 'tenant' | 'template';

export interface NavItem {
	id: string;
	label: MessageKey;
	icon: IconName;
	/** Lists and dashboards use the wide page width; forms use the standard width. */
	wide?: boolean;
	/**
	 * The page owns the left column, so no left nav is shown. Service flows: the list needs
	 * the width, and the flow editor puts the flow diagram there instead.
	 */
	ownsSide?: boolean;
	platform?: PlatformTreatment;
	/** Message key prefix of a retirement note (what must be resolved before removal). */
	retire?: string;
	badge?: string;
	/** What the page needs; admins who could not use it do not see the item (nav-access.ts). */
	requires?: NavRequirement;
	legacyRoutes: readonly string[];
}

export interface NavArea {
	id: string;
	label: MessageKey;
	icon: IconName;
	scope: AreaScope;
	badge?: string;
	children: readonly NavItem[];
	legacyRoutes: readonly string[];
}

export interface TopEntry {
	id: string;
	label?: MessageKey;
	icon?: IconName;
	scope?: AreaScope;
	/** Areas shown together under this category; the first one is the landing area. */
	merges?: readonly string[];
	inherited?: boolean;
}

export type ScopeKind = 'tenant' | 'platform';
