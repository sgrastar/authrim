import type {
	ApplicationLauncher,
	LauncherApplicationType,
	LauncherAttributeOperator,
	LauncherIconType,
	LauncherInput,
	LauncherLaunchType,
	LauncherOptions,
	LauncherVisibilityMode
} from '#lib/api/launchers.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';
import type { PickerItem } from '#lib/ui/patterns/EntityPicker.svelte';
import { contrastRatio } from '#lib/ui/primitives/color.js';

/**
 * A launcher as its editor holds it: text fields as strings (empty for none), the icon's
 * Phosphor name and image address kept apart (switching between them loses neither), and the
 * chosen users and groups with their names (the picker shows them as chips).
 */
export interface LauncherEditorValue {
	name: string;
	description: string;
	category: string;
	applicationType: LauncherApplicationType;
	/** The OIDC client or SAML service provider; '' for none. */
	applicationId: string;
	launchType: LauncherLaunchType;
	launchUrl: string;
	deepLinkUrl: string;
	openInNewTab: boolean;
	iconType: LauncherIconType;
	iconName: string;
	imageUrl: string;
	iconColor: string;
	/** The square behind the icon. */
	backgroundColor: string;
	/** Whether the whole tile has a colour of its own (otherwise the theme's card colour). */
	tileColored: boolean;
	/** The tile's colour, kept while it is off so turning it back on brings it back. */
	tileBackground: string;
	gridWidth: number;
	enabled: boolean;
	allowFavorite: boolean;
	audience: LauncherVisibilityMode;
	attributeMatch: 'all' | 'any';
	users: PickerItem[];
	groups: PickerItem[];
	rules: AttributeRuleRow[];
}

/** One attribute rule as a row of the rules table. */
export interface AttributeRuleRow extends Record<string, unknown> {
	id: string;
	attribute_key: string;
	operator: LauncherAttributeOperator;
	attribute_value: string;
}

export const ATTRIBUTE_OPERATORS: readonly LauncherAttributeOperator[] = [
	'equals',
	'not_equals',
	'contains',
	'starts_with',
	'ends_with',
	'exists'
];
/** The Admin API's limits. */
export const LIMITS = {
	name: 120,
	description: 1000,
	category: 100,
	url: 2048,
	relayStateBytes: 80,
	subjects: 500,
	rules: 32,
	ruleValue: 500
} as const;
export const COLOR_PATTERN = /^#[0-9a-f]{6}$/iu;
export const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
export const GRID_COLUMNS = 8;
export const DEFAULT_ICON = 'rocket-launch';
export const DEFAULT_ICON_COLOR = '#ffffff';
export const DEFAULT_BACKGROUND = '#2563eb';
export const DEFAULT_TILE_BACKGROUND = '#dbeafe';
/** The text colour that reads on a tile's own colour: black or white, whichever contrasts more. */
export function tileTextColor(background: string): '#000000' | '#ffffff' {
	return contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff')
		? '#000000'
		: '#ffffff';
}

/** Light tile colours offered beside the colour field (the icon square stays readable on them). */
export const TILE_PRESETS = [
	'#dbeafe',
	'#ccfbf1',
	'#dcfce7',
	'#fef9c3',
	'#ffedd5',
	'#fee2e2',
	'#fce7f3',
	'#ede9fe',
	'#e2e8f0',
	'#1e293b'
] as const;

/** Icon backgrounds offered beside the colour field. */
export const BACKGROUND_PRESETS = [
	'#2563eb',
	'#0f766e',
	'#16a34a',
	'#ca8a04',
	'#ea580c',
	'#dc2626',
	'#db2777',
	'#7c3aed',
	'#334155',
	'#0f172a'
] as const;

export function newLauncherValue(): LauncherEditorValue {
	return {
		name: '',
		description: '',
		category: '',
		applicationType: 'standalone',
		applicationId: '',
		launchType: 'bookmark',
		launchUrl: '',
		deepLinkUrl: '',
		openInNewTab: true,
		iconType: 'phosphor',
		iconName: DEFAULT_ICON,
		imageUrl: '',
		iconColor: DEFAULT_ICON_COLOR,
		backgroundColor: DEFAULT_BACKGROUND,
		tileColored: false,
		tileBackground: DEFAULT_TILE_BACKGROUND,
		gridWidth: 2,
		enabled: true,
		allowFavorite: true,
		audience: 'everyone',
		attributeMatch: 'all',
		users: [],
		groups: [],
		rules: []
	};
}

/** The editor's value for a saved launcher; `names` gives what is known of chosen users and groups. */
export function launcherValue(
	launcher: ApplicationLauncher,
	names: { users: ReadonlyMap<string, PickerItem>; groups: ReadonlyMap<string, PickerItem> }
): LauncherEditorValue {
	const image = launcher.icon_type === 'image';
	return {
		name: launcher.name,
		description: launcher.description ?? '',
		category: launcher.category ?? '',
		applicationType: launcher.application_type,
		applicationId: launcher.application_id ?? '',
		launchType: launcher.launch_type,
		launchUrl: launcher.launch_url ?? '',
		deepLinkUrl: launcher.deep_link_url ?? '',
		openInNewTab: launcher.open_in_new_tab,
		iconType: launcher.icon_type,
		iconName: image ? DEFAULT_ICON : launcher.icon_value,
		imageUrl: image ? launcher.icon_value : '',
		iconColor: launcher.icon_color,
		backgroundColor: launcher.background_color,
		tileColored: launcher.tile_background_color !== null,
		tileBackground: launcher.tile_background_color ?? DEFAULT_TILE_BACKGROUND,
		gridWidth: launcher.grid_width,
		enabled: launcher.enabled,
		allowFavorite: launcher.allow_favorite,
		audience: launcher.visibility.mode,
		attributeMatch: launcher.visibility.attribute_match,
		users: launcher.visibility.user_ids.map(
			(id) => names.users.get(id) ?? { value: id, label: id }
		),
		groups: launcher.visibility.group_ids.map(
			(id) => names.groups.get(id) ?? { value: id, label: id }
		),
		rules: launcher.visibility.attribute_rules.map((rule) => ({
			id: rule.id,
			attribute_key: rule.attribute_key,
			operator: rule.operator,
			attribute_value: rule.attribute_value ?? ''
		}))
	};
}

const orNull = (value: string) => value.trim() || null;

/**
 * What is sent for the editor's value. Only the audience in use keeps its lists, and only the
 * addresses the launch type uses are sent (IdP-initiated SSO has no launch URL, SP-initiated SSO no
 * deep link), so nothing hidden is stored by accident.
 */
export function launcherInput(
	value: LauncherEditorValue,
	/** Where a new launcher goes; omitted for a change, so the order set in the list is kept. */
	sortOrder: number | undefined,
	/** OIDC third-party initiated login starts at the client's own address, never one typed. */
	initiateLoginUri: string | null = null
): LauncherInput {
	const audience = value.audience;
	const thirdParty = value.launchType === 'oidc_third_party_initiated';
	return {
		application_type: value.applicationType,
		application_id: value.applicationType === 'standalone' ? null : orNull(value.applicationId),
		name: value.name.trim(),
		description: orNull(value.description),
		category: orNull(value.category),
		launch_type: value.launchType,
		launch_url: thirdParty
			? initiateLoginUri
			: value.launchType === 'saml_idp_initiated'
				? null
				: orNull(value.launchUrl),
		deep_link_url: value.launchType === 'saml_sp_initiated' ? null : orNull(value.deepLinkUrl),
		open_in_new_tab: value.openInNewTab,
		icon_type: value.iconType,
		icon_value: value.iconType === 'image' ? value.imageUrl.trim() : value.iconName,
		// A picture has no icon colour to show; an unset one is not sent as it is.
		icon_color:
			value.iconType === 'image' && !COLOR_PATTERN.test(value.iconColor)
				? DEFAULT_ICON_COLOR
				: value.iconColor,
		background_color: value.backgroundColor,
		tile_background_color: value.tileColored ? value.tileBackground : null,
		grid_width: value.gridWidth,
		...(sortOrder === undefined ? {} : { sort_order: sortOrder }),
		enabled: value.enabled,
		allow_favorite: value.allowFavorite,
		visibility: {
			mode: audience,
			attribute_match: value.attributeMatch,
			user_ids: audience === 'users' ? value.users.map((user) => user.value) : [],
			group_ids: audience === 'groups' ? value.groups.map((group) => group.value) : [],
			attribute_rules:
				audience === 'attributes'
					? value.rules.map((rule) => ({
							id: rule.id,
							attribute_key: rule.attribute_key.trim(),
							operator: rule.operator,
							attribute_value: rule.operator === 'exists' ? null : rule.attribute_value.trim()
						}))
					: []
		}
	};
}

/** The launch types an application can be opened with, the default first. */
export function launchTypesFor(type: LauncherApplicationType): LauncherLaunchType[] {
	if (type === 'oidc_client') return ['bookmark', 'oidc_third_party_initiated'];
	if (type === 'saml_sp') return ['saml_sp_initiated', 'bookmark', 'saml_idp_initiated'];
	return ['bookmark'];
}

/** An HTTPS address, as the Admin API accepts it. */
export function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value.trim()).protocol === 'https:';
	} catch {
		return false;
	}
}

const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Where the editor can send the admin to fix a problem. */
export type ProblemField =
	| 'name'
	| 'applicationId'
	| 'launchType'
	| 'launchUrl'
	| 'deepLinkUrl'
	| 'imageUrl'
	| 'colors'
	| 'users'
	| 'groups'
	| 'rules';

/**
 * What keeps the value from being saved, per field, in the admin's words. `clients` and
 * `samlProviders` are the applications that can be chosen now.
 */
export function launcherProblems(
	value: LauncherEditorValue,
	choices: {
		clients: LauncherOptions['oidc_clients'];
		samlProviderIds: ReadonlySet<string>;
		/** False when the applications could not be read: a chosen one is not called unavailable. */
		optionsKnown?: boolean;
	}
): Partial<Record<ProblemField, MessageKey>> {
	const found: Partial<Record<ProblemField, MessageKey>> = {};
	if (!value.name.trim()) found.name = 'ln.error.nameRequired';

	const known = choices.optionsKnown !== false;
	const client = choices.clients.find((entry) => entry.client_id === value.applicationId);
	if (value.applicationType === 'oidc_client') {
		if (!value.applicationId) found.applicationId = 'ln.error.clientRequired';
		else if (known && !client) found.applicationId = 'ln.error.clientUnavailable';
	} else if (value.applicationType === 'saml_sp') {
		if (!value.applicationId) found.applicationId = 'ln.error.spRequired';
		else if (known && !choices.samlProviderIds.has(value.applicationId))
			found.applicationId = 'ln.error.spUnavailable';
	}
	if (!launchTypesFor(value.applicationType).includes(value.launchType)) {
		found.launchType = 'ln.error.launchTypeInvalid';
	} else if (
		value.launchType === 'oidc_third_party_initiated' &&
		client &&
		!client.initiate_login_uri
	)
		found.launchType = 'ln.error.noInitiateLoginUri';

	const url = value.launchUrl.trim();
	if (value.launchType === 'bookmark' || value.launchType === 'saml_sp_initiated') {
		if (!url) found.launchUrl = 'ln.error.urlRequired';
		else if (!isHttpsUrl(url)) found.launchUrl = 'ln.error.httpsOnly';
	}
	const deepLink = value.deepLinkUrl.trim();
	if (deepLink && value.launchType !== 'saml_sp_initiated') {
		if (!isHttpsUrl(deepLink)) found.deepLinkUrl = 'ln.error.httpsOnly';
		else if (
			value.launchType === 'saml_idp_initiated' &&
			bytes(new URL(deepLink).toString()) > LIMITS.relayStateBytes
		)
			found.deepLinkUrl = 'ln.error.relayStateTooLong';
	}

	if (value.iconType === 'image') {
		if (!value.imageUrl.trim()) found.imageUrl = 'ln.error.imageRequired';
		else if (!isHttpsUrl(value.imageUrl)) found.imageUrl = 'ln.error.httpsOnly';
	}

	if (
		!COLOR_PATTERN.test(value.backgroundColor) ||
		(value.iconType === 'phosphor' && !COLOR_PATTERN.test(value.iconColor)) ||
		(value.tileColored && !COLOR_PATTERN.test(value.tileBackground))
	)
		found.colors = 'ln.error.colorRequired';

	if (value.audience === 'users' && value.users.length === 0)
		found.users = 'ln.error.usersRequired';
	if (value.audience === 'groups' && value.groups.length === 0)
		found.groups = 'ln.error.groupsRequired';
	if (value.audience === 'attributes') {
		if (value.rules.length === 0) found.rules = 'ln.error.rulesRequired';
		else if (value.rules.length > LIMITS.rules) found.rules = 'ln.error.rulesTooMany';
		else if (
			value.rules.some(
				(rule) =>
					!ATTRIBUTE_KEY_PATTERN.test(rule.attribute_key.trim()) ||
					(rule.operator !== 'exists' && !rule.attribute_value.trim())
			)
		)
			found.rules = 'ln.error.rulesInvalid';
	}
	return found;
}

/** The sort order of a launcher added after these (the account page shows it last). */
export function nextSortOrder(launchers: readonly ApplicationLauncher[]): number {
	const highest = launchers.reduce((max, launcher) => Math.max(max, launcher.sort_order), -10);
	return Math.min(highest + 10, 1_000_000);
}

/** The categories in use, for suggestions: each once, in the viewer's order. */
export function categoriesOf(launchers: readonly ApplicationLauncher[], locale: string): string[] {
	return [
		...new Set(launchers.map((launcher) => launcher.category?.trim() ?? '').filter(Boolean))
	].sort((left, right) => left.localeCompare(right, locale));
}

/** The launcher list after moving one entry by one place; unchanged at either end. */
export function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
	const to = index + by;
	if (index < 0 || index >= items.length || to < 0 || to >= items.length) return [...items];
	const next = [...items];
	[next[index], next[to]] = [next[to], next[index]];
	return next;
}
