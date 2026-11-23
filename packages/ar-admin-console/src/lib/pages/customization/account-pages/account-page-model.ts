/**
 * Account pages (Customization → Account page): reading what is stored, the preset every page
 * starts from, adding and moving the places of a page, what a page shows in each language, and
 * what publishing checks and takes a snapshot of.
 *
 * What is stored is checked by the Admin API (page ids, at most 24 pages and 32 places a page,
 * unique place ids and screen keys, a snapshot of every enabled place once published), so the
 * shapes here keep to its rules.
 */
import {
	ACCOUNT_PAGE_PRESET_VERSION,
	DEFAULT_ACCOUNT_PAGE_DEFINITION
} from '@authrim/ar-lib-core/types/screens';
import type {
	AccountPagesRaw,
	PageDefinition,
	PageLocalization,
	PageRecord,
	PagesDocument,
	Placement,
	PlacementCondition,
	PublishedDefinition
} from '#lib/api/account-pages.js';
import type { Screen } from '#lib/api/screens.js';
import type { Translations } from '#lib/ui/builder/TranslationTable.svelte';

export const PRESET_PAGE_ID = 'authrim-default';
export const MAX_PAGES = 24;
export const MAX_PLACEMENTS = 32;

export const CONDITIONS: readonly PlacementCondition[] = [
	'always',
	'hidden',
	'passkey_enabled',
	'totp_enabled',
	'external_idp_enabled',
	'consent_records_available',
	'multiple_sessions'
];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The preset's page: what a new page starts from. */
export function presetDefinition(): PageDefinition {
	return clone(DEFAULT_ACCOUNT_PAGE_DEFINITION) as PageDefinition;
}

/** A page as stored, or what the API would accept of it: bad places are dropped, ids made unique. */
export function normalizeDefinition(value: unknown): PageDefinition {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return presetDefinition();
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.screens)) return presetDefinition();
	const used = new Set<string>();
	const usedKeys = new Set<string>();
	const screens: Placement[] = [];
	for (const [index, entry] of record.screens.slice(0, MAX_PLACEMENTS).entries()) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const item = entry as Record<string, unknown>;
		const key = typeof item.screen_key === 'string' ? item.screen_key.trim() : '';
		if (!/^[a-z0-9_-]{1,96}$/u.test(key) || usedKeys.has(key)) continue;
		usedKeys.add(key);
		const preferred =
			typeof item.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/u.test(item.id)
				? item.id
				: `${key}-${index + 1}`;
		let id = preferred;
		for (let suffix = 2; used.has(id); suffix += 1) id = `${preferred}-${suffix}`;
		used.add(id);
		screens.push({
			id,
			screen_key: key,
			width: item.width === 'half' ? 'half' : 'full',
			enabled: item.enabled !== false,
			show_for_guests: item.show_for_guests !== false,
			condition: CONDITIONS.includes(item.condition as PlacementCondition)
				? (item.condition as PlacementCondition)
				: 'always'
		});
	}
	const title = typeof record.title === 'string' ? record.title.trim().slice(0, 120) : '';
	const description =
		typeof record.description === 'string' ? record.description.trim().slice(0, 1000) : '';
	return {
		schema_version: 'authrim.account_page.v1',
		base_preset_id: 'authrim-default',
		base_preset_version:
			typeof record.base_preset_version === 'number'
				? record.base_preset_version
				: ACCOUNT_PAGE_PRESET_VERSION,
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(record.localizations && typeof record.localizations === 'object'
			? { localizations: record.localizations as Record<string, PageLocalization> }
			: {}),
		screens
	};
}

function record(id: string, name: string, draft: PageDefinition, now: number): PageRecord {
	return {
		id,
		name: name.trim().slice(0, 80) || id,
		base_preset_id: 'authrim-default',
		base_preset_version: ACCOUNT_PAGE_PRESET_VERSION,
		draft,
		published_version: 0,
		published_at: '',
		created_at: now,
		updated_at: now
	};
}

/**
 * What is stored, as pages. With nothing stored, one page of the preset (and what an older
 * console kept as a single page, if any) is shown; it is stored with the first save.
 */
export function parsePagesDocument(
	raw: AccountPagesRaw,
	presetName: string,
	now: number
): { document: PagesDocument; stored: boolean } {
	if (typeof raw.pages === 'string' && raw.pages.trim()) {
		try {
			const parsed = JSON.parse(raw.pages) as PagesDocument;
			if (parsed.schema_version === 'authrim.account_pages.v1' && Array.isArray(parsed.pages)) {
				return {
					stored: true,
					document: {
						schema_version: 'authrim.account_pages.v1',
						default_page_id: parsed.default_page_id ?? null,
						pages: parsed.pages.map((page) => {
							// No rollback any more: a stored one is dropped on the next save.
							const { rollback: _kept, ...rest } = page as PageRecord & { rollback?: unknown };
							void _kept;
							return { ...rest, draft: normalizeDefinition(rest.draft) };
						})
					}
				};
			}
		} catch {
			// Not a document: the preset is shown below.
		}
	}
	let draft = presetDefinition();
	if (typeof raw.legacy === 'string' && raw.legacy.trim()) {
		try {
			draft = normalizeDefinition(JSON.parse(raw.legacy));
		} catch {
			// An unreadable single page is left behind.
		}
	}
	return {
		stored: false,
		document: {
			schema_version: 'authrim.account_pages.v1',
			default_page_id: null,
			pages: [record(PRESET_PAGE_ID, presetName, draft, now)]
		}
	};
}

/** An id for a new page, unused in `existing` (`[a-z0-9_-]`, as the API requires). */
export function newPageId(existing: readonly string[], now: number): string {
	const base = `account-page-${now.toString(36)}`;
	let id = base;
	for (let suffix = 2; existing.includes(id); suffix += 1) id = `${base}-${suffix}`;
	return id;
}

export function newPage(existing: readonly string[], name: string, now: number): PageRecord {
	return record(newPageId(existing, now), name, presetDefinition(), now);
}

/** A copy of a page's draft (not its publication) as a new page. */
export function duplicatePage(
	source: PageRecord,
	existing: readonly string[],
	name: string,
	now: number
): PageRecord {
	return record(newPageId(existing, now), name, normalizeDefinition(clone(source.draft)), now);
}

// ---- Places of a page ----

/** The screen a place shows, from the screens of the tenant. */
export function screenOf(placement: Placement, screens: readonly Screen[]): Screen | undefined {
	return screens.find((screen) => screen.screen_key === placement.screen_key);
}

/** Active account screens that are not yet placed on the page. */
export function unplaced(definition: PageDefinition, screens: readonly Screen[]): Screen[] {
	const placed = new Set(definition.screens.map((placement) => placement.screen_key));
	return screens.filter((screen) => !placed.has(screen.screen_key));
}

/** The id a place of `screen` gets: the screen's key without its `account_` prefix, made unique. */
export function placementIdFor(screen: Screen, taken: readonly string[]): string {
	const base =
		screen.screen_key.replace(/^account_/u, '').replace(/[^a-zA-Z0-9_-]/gu, '-') || 'screen';
	let id = base.slice(0, 90);
	for (let suffix = 2; taken.includes(id); suffix += 1) id = `${base.slice(0, 90)}-${suffix}`;
	return id;
}

export function addPlacement(definition: PageDefinition, screen: Screen): PageDefinition {
	if (
		definition.screens.length >= MAX_PLACEMENTS ||
		definition.screens.some((placement) => placement.screen_key === screen.screen_key)
	) {
		return definition;
	}
	return {
		...definition,
		screens: [
			...definition.screens,
			{
				id: placementIdFor(
					screen,
					definition.screens.map((placement) => placement.id)
				),
				screen_key: screen.screen_key,
				width: 'full',
				enabled: true,
				condition: 'always',
				show_for_guests: true
			}
		]
	};
}

export function removePlacement(definition: PageDefinition, id: string): PageDefinition {
	return { ...definition, screens: definition.screens.filter((placement) => placement.id !== id) };
}

/** Moves the place `id` one step (-1 up, +1 down); an end stays where it is. */
export function movePlacement(
	definition: PageDefinition,
	id: string,
	step: -1 | 1
): PageDefinition {
	const from = definition.screens.findIndex((placement) => placement.id === id);
	const to = from + step;
	if (from < 0 || to < 0 || to >= definition.screens.length) return definition;
	const screens = [...definition.screens];
	[screens[from], screens[to]] = [screens[to], screens[from]];
	return { ...definition, screens };
}

/**
 * The rows the page is drawn in: a full place is a row of its own; two half places in a row are
 * side by side, and a half place with no half place after it fills its row alone.
 */
export function placementRows(screens: readonly Placement[]): Placement[][] {
	const rows: Placement[][] = [];
	for (const placement of screens) {
		const last = rows[rows.length - 1];
		if (placement.width === 'half' && last && last.length === 1 && last[0].width === 'half') {
			last.push(placement);
		} else {
			rows.push([placement]);
		}
	}
	return rows;
}

// ---- State of a page ----

/** The part of a published page that is the page (its snapshot and time left out). */
function plain(published: PublishedDefinition | PageDefinition): PageDefinition {
	const {
		resolved_at: _at,
		screen_snapshots: _snapshots,
		...rest
	} = published as PublishedDefinition;
	void _at;
	void _snapshots;
	return normalizeDefinition(rest);
}

export function sameDefinition(a: PageDefinition, b: PageDefinition): boolean {
	return JSON.stringify(normalizeDefinition(a)) === JSON.stringify(normalizeDefinition(b));
}

/**
 * - `unpublished`: never published.
 * - `published`: the live page is the draft, and the screens are as they were when it was made.
 * - `changed`: the draft differs from the live page, or a screen it places has changed since (the
 *   live page keeps the snapshot it took, so the change reaches users when it is published again).
 */
export type PageState = 'unpublished' | 'published' | 'changed';

/** Whether a screen the live page places is not what its snapshot was taken from. */
export function snapshotsStale(page: PageRecord, screens: readonly Screen[]): boolean {
	if (!page.published) return false;
	return Object.entries(page.published.screen_snapshots).some(([key, snapshot]) => {
		const current = screens.find((screen) => screen.screen_key === key);
		return !current || current.version !== snapshot.version;
	});
}

export function pageState(page: PageRecord, screens?: readonly Screen[]): PageState {
	if (!page.published) return 'unpublished';
	if (!sameDefinition(plain(page.published), page.draft)) return 'changed';
	return screens && snapshotsStale(page, screens) ? 'changed' : 'published';
}

// ---- Publishing ----

export type PublishProblem =
	| { code: 'duplicate_place' }
	| { code: 'duplicate_screen' }
	| { code: 'screen_missing'; screenKey: string }
	| { code: 'multiple_widgets'; name: string }
	| { code: 'link_target'; target: string };

export type BuiltPublication =
	| { ok: true; published: PublishedDefinition }
	| { ok: false; problem: PublishProblem };

/**
 * Checks a draft for publishing and takes a snapshot of every enabled place's screen. The same
 * screen cannot be placed twice, a screen must exist and be active, a screen has at most one
 * account widget, and a link to `#place` must point at a place that is always shown.
 */
export function buildPublication(
	definition: PageDefinition,
	screens: readonly Screen[],
	now: string
): BuiltPublication {
	const ids = new Set<string>();
	const keys = new Set<string>();
	const snapshots: Record<string, Screen> = {};
	for (const placement of definition.screens.filter((item) => item.enabled)) {
		if (ids.has(placement.id)) return { ok: false, problem: { code: 'duplicate_place' } };
		if (keys.has(placement.screen_key)) return { ok: false, problem: { code: 'duplicate_screen' } };
		ids.add(placement.id);
		keys.add(placement.screen_key);
		const screen = screens.find(
			(item) => item.screen_key === placement.screen_key && item.is_active
		);
		if (!screen) {
			return { ok: false, problem: { code: 'screen_missing', screenKey: placement.screen_key } };
		}
		const widgets = screen.fields.filter((field) => field.block_type?.startsWith('account_'));
		if (widgets.length > 1) {
			return { ok: false, problem: { code: 'multiple_widgets', name: screen.display_name } };
		}
		snapshots[placement.screen_key] = clone(screen);
	}
	const stable = new Set(
		definition.screens
			.filter((placement) => placement.enabled && placement.condition === 'always')
			.map((placement) => placement.id)
	);
	for (const screen of Object.values(snapshots)) {
		for (const field of screen.fields) {
			if (field.block_type === 'link' && field.href?.startsWith('#')) {
				if (!stable.has(field.href.slice(1))) {
					return { ok: false, problem: { code: 'link_target', target: field.href } };
				}
			}
		}
	}
	return {
		ok: true,
		published: { ...clone(definition), resolved_at: now, screen_snapshots: snapshots }
	};
}

/** The page after publishing its draft: the live page and a new version. */
export function publishedPage(
	page: PageRecord,
	definition: PageDefinition,
	published: PublishedDefinition,
	nowMs: number
): PageRecord {
	return {
		...page,
		draft: definition,
		published,
		published_version: page.published_version + 1,
		published_at: published.resolved_at,
		updated_at: nowMs
	};
}

// ---- Page title and description in each language ----

export const TEXT_ROWS = ['title', 'description'] as const;

/** The longest heading and description (what the API keeps; longer text is refused, not cut). */
export const TEXT_LIMITS = { title: 120, description: 1000 } as const;

/** Whether a text in some language is longer than the page keeps. */
export function translationsTooLong(translations: Translations): boolean {
	return TEXT_ROWS.some((row) =>
		Object.values(translations[row] ?? {}).some((text) => text.trim().length > TEXT_LIMITS[row])
	);
}

/**
 * The localizations (`{ ja: { title, description } }`) as the translation table holds them: by
 * text id, then language (`{ title: { ja: … }, description: { ja: … } }`).
 */
export function definitionToTranslations(definition: PageDefinition): Translations {
	const out: Translations = {};
	for (const [locale, text] of Object.entries(definition.localizations ?? {})) {
		for (const row of TEXT_ROWS) {
			const value = text[row];
			if (value) (out[row] ??= {})[locale] = value;
		}
	}
	return out;
}

export function translationsToLocalizations(
	translations: Translations
): Record<string, PageLocalization> | undefined {
	const out: Record<string, PageLocalization> = {};
	for (const row of TEXT_ROWS) {
		for (const [locale, raw] of Object.entries(translations[row] ?? {})) {
			const value = raw.trim().slice(0, TEXT_LIMITS[row]);
			if (value) out[locale] = { ...out[locale], [row]: value };
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
