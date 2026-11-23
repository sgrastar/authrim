/**
 * The tenant's account pages: what the signed-in user sees at their account page, as a list of
 * pages, each placing account screens in order (full or half width) with a condition for when a
 * placement is shown. They are kept as one JSON document in the Login UI settings
 * (`login-ui.account_pages`), written with the settings version the page was read at, so another
 * admin's save is not overwritten.
 *
 * A page has a draft and, once published, the published page with a snapshot of each screen it
 * places (the Login UI draws the snapshot, so a later change to a screen does not reach the
 * account page until the page is published again). There is no rollback: save keeps the draft,
 * publish makes it live.
 */
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import { httpScreens, type Screen } from './screens';
import { httpSettings } from './settings';
import { RejectedError } from './api-error';

export type PlacementWidth = 'full' | 'half';

/** When a placed screen is shown (`always`: whenever the page is). */
export type PlacementCondition =
	| 'always'
	| 'hidden'
	| 'passkey_enabled'
	| 'totp_enabled'
	| 'external_idp_enabled'
	| 'consent_records_available'
	| 'multiple_sessions';

export interface Placement {
	/** The place's own id (a link on another screen points at it as `#id`). */
	id: string;
	screen_key: string;
	width: PlacementWidth;
	enabled: boolean;
	condition: PlacementCondition;
	show_for_guests: boolean;
}

export interface PageLocalization {
	title?: string;
	description?: string;
}

export interface PageDefinition {
	schema_version: 'authrim.account_page.v1';
	base_preset_id?: 'authrim-default';
	base_preset_version?: number;
	title?: string;
	description?: string;
	localizations?: Record<string, PageLocalization>;
	screens: Placement[];
}

export interface PublishedDefinition extends PageDefinition {
	resolved_at: string;
	/** Each placed screen as it was when the page was published. */
	screen_snapshots: Record<string, Screen>;
}

export interface PageRecord {
	id: string;
	name: string;
	base_preset_id: 'authrim-default';
	base_preset_version: number;
	draft: PageDefinition;
	published?: PublishedDefinition;
	/** 0 until the page is first published. */
	published_version: number;
	/** '' until the page is first published. */
	published_at: string;
	created_at: number;
	updated_at: number;
}

export interface PagesDocument {
	schema_version: 'authrim.account_pages.v1';
	/** The page the account page shows (null while none is published). */
	default_page_id: string | null;
	pages: PageRecord[];
}

export interface AccountPagesState {
	document: PagesDocument;
	/** The settings version the document was read at, to save over. */
	version: string;
	/** False while nothing is stored yet: the preset is shown and stored with the first save. */
	stored: boolean;
	/** The tenant's active account screens, to place and to snapshot at publish. */
	screens: Screen[];
}

export interface AccountPagesClient {
	load(signal?: AbortSignal): Promise<AccountPagesState>;
	/**
	 * Stores the document over `version`; answers the new version. Another admin's save in
	 * between answers 409. `clearThemeFor` removes a deleted page from the themes that use it.
	 */
	save(
		document: PagesDocument,
		version: string,
		options?: { clearThemeFor?: string }
	): Promise<string>;
}

const PAGES_KEY = 'login-ui.account_pages';
const DRAFT_KEY = 'login-ui.account_page_draft';
const PUBLISHED_KEY = 'login-ui.account_page_published';
const THEMES_KEY = 'login-ui.custom_themes';

/** The raw values the page reads, for the model to turn into a document. */
export interface AccountPagesRaw {
	pages: unknown;
	/** The single draft or published page an older console kept, to carry over. */
	legacy: unknown;
}

export function rawFromValues(values: Record<string, unknown>): AccountPagesRaw {
	return {
		pages: values[PAGES_KEY],
		legacy: values[DRAFT_KEY] || values[PUBLISHED_KEY]
	};
}

/** The themes document with `pageId` taken out of the themes that use it; null when none does. */
export function themesWithoutPage(raw: unknown, pageId: string): string | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	try {
		const document = JSON.parse(raw) as { themes?: Array<Record<string, unknown>> };
		if (!Array.isArray(document.themes)) return null;
		if (!document.themes.some((theme) => theme.account_page_id === pageId)) return null;
		return JSON.stringify({
			...document,
			themes: document.themes.map((theme) =>
				theme.account_page_id === pageId ? { ...theme, account_page_id: null } : theme
			)
		});
	} catch {
		return null;
	}
}

export type PagesParser = (raw: AccountPagesRaw) => { document: PagesDocument; stored: boolean };

/** The Admin API, through the settings and the screens. `parse` is the model's reading of the raw values. */
export function httpAccountPages(parse: PagesParser): AccountPagesClient {
	const target = () => ({ level: 'tenant' as const, tenantId: tenantScope.tenantId ?? '' });
	return {
		async load(signal) {
			const [settings, screens] = await Promise.all([
				httpSettings.get(target(), 'login-ui', signal),
				httpScreens.list(signal)
			]);
			const { document, stored } = parse(rawFromValues(settings.values));
			return {
				document,
				stored,
				version: settings.version,
				screens: screens.screens.filter(
					(screen) => screen.screen_kind === 'account' && screen.is_active
				)
			};
		},
		async save(document, version, options) {
			const set: Record<string, unknown> = { [PAGES_KEY]: JSON.stringify(document) };
			if (options?.clearThemeFor) {
				const current = await httpSettings.get(target(), 'login-ui');
				const themes = themesWithoutPage(current.values[THEMES_KEY], options.clearThemeFor);
				if (themes !== null) set[THEMES_KEY] = themes;
			}
			const result = await httpSettings.patch(target(), 'login-ui', { ifMatch: version, set });
			if (Object.keys(result.rejected).length > 0) {
				throw new RejectedError(Object.values(result.rejected).join(' '), {
					rejected: result.rejected
				});
			}
			return result.version;
		}
	};
}
