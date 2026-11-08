/**
 * The lite account page's composition (lite plan PR7b): which placements of the tenant's account
 * page are shown, in what order, with which blocks and words. The rules are the SPA's
 * (AccountPage.svelte `placementVisible`, `localizedScreenFields`, `accountWidgetTitle`,
 * lib/account/account-screen-href.ts), applied on the server.
 */
import { record } from './totp-passkey';

export type LiteAccountWidget =
	| 'account_upgrade_widget'
	| 'account_profile_widget'
	| 'account_device_list_widget'
	| 'account_session_widget'
	| 'account_passkey_widget'
	| 'account_totp_widget'
	| 'account_consent_widget'
	| 'account_activity_widget'
	| 'account_social_account_widget'
	| 'account_launcher_widget';

export const LITE_ACCOUNT_WIDGETS: ReadonlySet<string> = new Set<LiteAccountWidget>([
	'account_upgrade_widget',
	'account_profile_widget',
	'account_device_list_widget',
	'account_session_widget',
	'account_passkey_widget',
	'account_totp_widget',
	'account_consent_widget',
	'account_activity_widget',
	'account_social_account_widget',
	'account_launcher_widget'
]);

export type LiteAccountCondition =
	| 'always'
	| 'hidden'
	| 'passkey_enabled'
	| 'totp_enabled'
	| 'external_idp_enabled'
	| 'consent_records_available'
	| 'multiple_sessions';

export interface LiteAccountPlacement {
	id: string;
	screenKey: string;
	width: 'full' | 'half';
	enabled: boolean;
	condition: LiteAccountCondition;
	showForGuests: boolean;
}

export interface LiteAccountField {
	field: string;
	label: string;
	blockType: string;
	blockId: string | null;
	text: string | null;
	href: string | null;
	order: number;
	layoutColumn: 1 | 2 | null;
}

export interface LiteAccountScreen {
	screenKey: string;
	fields: LiteAccountField[];
	localizations: Record<string, { fields?: Record<string, Record<string, unknown>> }>;
}

export interface LiteAccountPageView {
	title: string | null;
	description: string | null;
	localizations: Record<string, { title?: unknown; description?: unknown }>;
	placements: LiteAccountPlacement[];
	screens: LiteAccountScreen[];
}

const CONDITIONS: ReadonlySet<string> = new Set([
	'always',
	'hidden',
	'passkey_enabled',
	'totp_enabled',
	'external_idp_enabled',
	'consent_records_available',
	'multiple_sessions'
]);

function text(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** The capabilities answer's account page, as the page reads it; null when it has none. */
export function readLiteAccountPage(json: unknown): LiteAccountPageView | null {
	const page = record(record(json).account_page);
	const definition = record(page.definition);
	if (!Array.isArray(definition.screens)) return null;
	const placements: LiteAccountPlacement[] = [];
	for (const raw of definition.screens.slice(0, 32)) {
		const item = record(raw);
		const id = text(item.id, 96);
		const screenKey = text(item.screen_key, 96);
		if (!id || !screenKey || !/^[A-Za-z0-9_-]+$/u.test(id)) continue;
		placements.push({
			id,
			screenKey,
			width: item.width === 'half' ? 'half' : 'full',
			enabled: item.enabled !== false,
			condition:
				typeof item.condition === 'string' && CONDITIONS.has(item.condition)
					? (item.condition as LiteAccountCondition)
					: 'always',
			showForGuests: item.show_for_guests !== false
		});
	}
	const screens: LiteAccountScreen[] = [];
	for (const raw of Array.isArray(page.screens) ? page.screens.slice(0, 64) : []) {
		const screen = record(raw);
		const screenKey = text(screen.screen_key, 96);
		if (!screenKey || !Array.isArray(screen.fields)) continue;
		const fields: LiteAccountField[] = [];
		for (const rawField of screen.fields.slice(0, 256)) {
			const field = record(rawField);
			const blockType = text(field.block_type, 64);
			if (!blockType) continue;
			const column = field.layout_column;
			fields.push({
				field: text(field.field, 200) ?? '',
				label: text(field.label, 200) ?? '',
				blockType,
				blockId: text(field.block_id, 160),
				text: text(field.text, 4000),
				href: text(field.href, 2048),
				order: typeof field.order === 'number' && Number.isFinite(field.order) ? field.order : 0,
				layoutColumn: column === 1 || column === 2 ? column : null
			});
		}
		screens.push({
			screenKey,
			fields,
			localizations: record(screen.localizations) as LiteAccountScreen['localizations']
		});
	}
	return {
		title: text(definition.title, 120),
		description: text(definition.description, 1000),
		localizations: record(definition.localizations) as LiteAccountPageView['localizations'],
		placements,
		screens
	};
}

/** What the visibility rules read: the person (guest or not), the methods, two lists. */
export interface LiteAccountConditions {
	registrationState: 'guest' | 'registered' | null;
	passkeyEnabled: boolean;
	totpManagementEnabled: boolean;
	externalIdpEnabled: boolean;
	consentRecordsAvailable: boolean;
	multipleSessions: boolean;
}

/** Whether a placement is shown (the SPA's `placementVisible`, its guest gate first). */
export function liteAccountPlacementVisible(
	placement: LiteAccountPlacement,
	conditions: LiteAccountConditions
): boolean {
	if (!placement.enabled) return false;
	if (conditions.registrationState !== 'registered' && !placement.showForGuests) return false;
	switch (placement.condition) {
		case 'hidden':
			return false;
		case 'passkey_enabled':
			return conditions.passkeyEnabled;
		case 'totp_enabled':
			return conditions.totpManagementEnabled;
		case 'external_idp_enabled':
			return conditions.externalIdpEnabled;
		case 'consent_records_available':
			return conditions.consentRecordsAvailable;
		case 'multiple_sessions':
			return conditions.multipleSessions;
		default:
			return true;
	}
}

/** The conditions the placements of the page read (to load only the lists they need). */
export function liteAccountConditionsUsed(page: LiteAccountPageView): Set<LiteAccountCondition> {
	return new Set(page.placements.filter((p) => p.enabled).map((p) => p.condition));
}

/** `l`, `l` with `-`, and its language (the SPA's `localeVariants`). */
export function liteLocaleVariants(locale: string): string[] {
	return [...new Set([locale, locale.replace('_', '-'), locale.split(/[-_]/u)[0]])];
}

/**
 * A screen's fields in order, with the words of the page's locale (else the tenant's default
 * locale) over their own: keyed by `block_id`, else `<field>-<index after sorting>`.
 */
export function liteAccountScreenFields(
	screen: LiteAccountScreen,
	locale: string,
	defaultLocale: string
): LiteAccountField[] {
	const pick = (candidate: string) =>
		liteLocaleVariants(candidate)
			.map((variant) => record(screen.localizations[variant]).fields)
			.find((fields) => fields && typeof fields === 'object' && Object.keys(fields).length > 0) as
			| Record<string, Record<string, unknown>>
			| undefined;
	const localized = pick(locale) ?? {};
	const fallback = pick(defaultLocale) ?? {};
	return [...screen.fields]
		.map((field, index) => ({ field, index }))
		.sort((a, b) => a.field.order - b.field.order || a.index - b.index)
		.map(({ field }, index) => {
			const key = field.blockId ?? `${field.field}-${index}`;
			const words = { ...record(fallback[key]), ...record(localized[key]) };
			// A translation's words, an empty one included (it clears what the block says).
			const word = (value: unknown, max: number) =>
				typeof value === 'string' && value.length <= max ? value : undefined;
			const label = word(words.label, 200);
			const said = word(words.text, 4000);
			const merged: LiteAccountField = {
				...field,
				label: label ?? field.label,
				text: said === undefined ? field.text : said || null
			};
			return screen.screenKey === 'account_overview' && field.field === 'heading.account_overview'
				? { ...merged, text: null }
				: merged;
		})
		.filter(
			(field) => screen.screenKey !== 'account_overview' || field.field !== 'link.account_security'
		);
}

/**
 * A link's target as the page may draw it (the SPA's `safeAccountScreenHref`): an anchor of a
 * placement shown, a path of this origin, or an https URL; null (the link left out) otherwise.
 */
export function liteAccountHref(
	value: string | null,
	anchorShown: (placementId: string) => boolean
): string | null {
	if (!value) return null;
	if (/^#[a-zA-Z][\w-]*$/u.test(value)) return anchorShown(value.slice(1)) ? value : null;
	if (/^\/(?![/\\])/u.test(value)) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

/** The English labels the seeds give (a widget so labelled is titled in the page's language). */
const SEED_LABELS: ReadonlySet<string> = new Set([
	'User profile',
	'Devices',
	'Connected apps and devices',
	'Sessions',
	'Signed-in devices',
	'Passkeys',
	'Authenticator app',
	'Consent information',
	'Account activity',
	'Connected accounts',
	'My applications'
]);
const SYSTEM_WIDGET_FIELDS: ReadonlySet<string> = new Set([
	'account.profile',
	'account.devices',
	'account.sessions',
	'account.passkeys',
	'account.totp',
	'account.consents',
	'account.activity',
	'account.social_accounts',
	'account.launchers'
]);

/** A widget's title: its own label, else (unset, a seed label, a system block) the default one. */
export function liteAccountWidgetTitle(field: LiteAccountField, defaultTitle: string): string {
	if (
		!field.label ||
		SEED_LABELS.has(field.label) ||
		(!field.blockId && SYSTEM_WIDGET_FIELDS.has(field.field))
	) {
		return defaultTitle;
	}
	return field.label;
}

/** The page's title and description: the page's locale, else its default, else its own. */
export function liteAccountPageWords(
	page: LiteAccountPageView,
	locale: string,
	defaultLocale: string,
	themeTitle: string | null
): { title: string | null; description: string | null } {
	const candidates = [
		...new Set([...liteLocaleVariants(locale), ...liteLocaleVariants(defaultLocale)])
	];
	const from = (key: 'title' | 'description') =>
		candidates
			.map((candidate) =>
				text(record(page.localizations[candidate])[key], key === 'title' ? 120 : 1000)
			)
			.find(Boolean) ?? null;
	return {
		title: themeTitle ?? from('title') ?? page.title,
		description: from('description') ?? page.description
	};
}
