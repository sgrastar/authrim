/**
 * A settings page's values while it is edited, and what to send when it is saved.
 *
 * Each setting on the screen is `{ v, here }`:
 *   v    — the value shown
 *   here — set at this scope (the tenant chose it), rather than taken from the deployment's
 *          environment or the built-in default
 * Turning `here` off and saving clears the setting at this scope (the API's `clear`), which is
 * how "Use the default" works; changing `v` sets it (`set`).
 *
 * Keys are stored with ':' instead of '.', because the SaveScope draft reads fields as dotted
 * paths ("session:default_ttl.v").
 */
import { ALL_CATEGORY_META, type CategoryName } from '@authrim/ar-lib-core/types/settings/catalog';
import type {
	InheritedSettingSource,
	SettingMeta
} from '@authrim/ar-lib-core/utils/settings-manager';
import type { AccessLevel } from '$lib/access/access';
import type { SettingsGetResult, SettingsPatchRequest } from '$lib/api/settings';
import { sameValue } from '$lib/ui/save/draft.svelte';
import {
	categoriesOf,
	categoryOf,
	type PlacedSetting,
	type SettingsPageDef,
	type SettingsSection
} from './placement';

export interface Entry {
	v: unknown;
	here: boolean;
	/** Fixed by the scope above: shown, never offered for change. */
	locked?: boolean;
}

export type Values = Record<string, Entry>;

export type Loaded = Partial<Record<CategoryName, SettingsGetResult>>;

export const fieldOf = (key: string): string => key.replaceAll('.', ':');
export const keyOf = (field: string): string => field.replaceAll(':', '.');

/**
 * The badge a setting carries where it is only read: still in development first (a saved value
 * has no effect), then fixed by the scope above, then set at this scope.
 */
export function readBadge(
	meta: Pick<SettingMeta, 'status'>,
	entry: Entry
): 'inDevelopment' | 'locked' | 'here' | null {
	if (meta.status === 'in_development') return 'inDevelopment';
	if (entry.locked) return 'locked';
	return entry.here ? 'here' : null;
}

export function metaOf(key: string): SettingMeta | undefined {
	const category = ALL_CATEGORY_META[categoryOf(key)];
	return category?.settings[key] as SettingMeta | undefined;
}

/** The values of a page as loaded. Settings the API did not return are left out. */
export function valuesFrom(page: SettingsPageDef, loaded: Loaded): Values {
	const values: Values = {};
	for (const section of page.sections) {
		for (const { key } of section.settings) {
			const result = loaded[categoryOf(key)];
			if (!result || !(key in result.values)) continue;
			values[fieldOf(key)] = {
				v: result.values[key],
				here: result.sources[key] === 'kv',
				...(result.locked?.includes(key) ? { locked: true } : {})
			};
		}
	}
	return values;
}

/** Where the value comes from while it is not set here: a parent scope, the environment, or the default. */
export type FallbackSource = InheritedSettingSource;

/** What applies when the setting is not set here, and where it comes from. */
export function fallbackOf(
	key: string,
	loaded: Loaded
): { value: unknown; source: FallbackSource } {
	const result = loaded[categoryOf(key)];
	if (!result) return { value: metaOf(key)?.default, source: 'default' };
	return { value: result.inherited.values[key], source: result.inherited.sources[key] };
}

function applies(setting: PlacedSetting, meta: SettingMeta | undefined, values: Values): boolean {
	if (!meta || setting.depth === 'hidden') return false;
	// A setting still in development is shown (as not changeable), not hidden.
	if (meta.visibility === 'internal') return false;
	if (setting.when && values[fieldOf(setting.when.key)]?.v !== setting.when.is) return false;
	return true;
}

export interface SectionView {
	section: SettingsSection;
	primary: PlacedSetting[];
	advanced: PlacedSetting[];
	/** Settings in the Advanced part that are set here (counted on its closed heading). */
	setHere: number;
}

/**
 * What a section shows now. `levels` leaves out settings of categories the admin cannot see;
 * a `search` setting shows (in Advanced) only while it is set here, now or as saved.
 */
export function sectionView(
	section: SettingsSection,
	values: Values,
	levels: Partial<Record<CategoryName, AccessLevel>>,
	saved: Values = values
): SectionView {
	const visible = section.settings.filter((setting) => {
		const field = fieldOf(setting.key);
		if (!(field in values)) return false;
		if ((levels[categoryOf(setting.key)] ?? 'none') === 'none') return false;
		return applies(setting, metaOf(setting.key), values);
	});
	const primary = visible.filter((s) => s.depth === 'primary');
	const advanced = visible.filter(
		(s) =>
			s.depth === 'advanced' ||
			(s.depth === 'search' && (values[fieldOf(s.key)]?.here || saved[fieldOf(s.key)]?.here))
	);
	return {
		section,
		primary,
		advanced,
		setHere: advanced.filter((s) => values[fieldOf(s.key)]?.here).length
	};
}

/** Per category, what to send to save the screen: changed values set, released ones cleared. */
export function changes(
	page: SettingsPageDef,
	saved: Values,
	current: Values
): Map<CategoryName, Omit<SettingsPatchRequest, 'ifMatch'>> {
	const result = new Map<CategoryName, Omit<SettingsPatchRequest, 'ifMatch'>>();
	for (const category of categoriesOf(page)) result.set(category, {});
	for (const [field, now] of Object.entries(current)) {
		const before = saved[field];
		if (!before) continue;
		const key = keyOf(field);
		const request = result.get(categoryOf(key));
		if (!request) continue;
		if (now.here && (!before.here || !sameValue(now.v, before.v))) {
			request.set = { ...request.set, [key]: now.v };
		} else if (!now.here && before.here) {
			request.clear = [...(request.clear ?? []), key];
		}
	}
	for (const [category, request] of result) {
		if (!request.set && !request.clear) result.delete(category);
	}
	return result;
}

/** Settings whose saved value differs between two loads (what someone else changed). */
export function changedBetween(before: Values, after: Values): string[] {
	return Object.keys(after)
		.filter((field) => {
			const a = before[field];
			const b = after[field];
			return !a || a.here !== b.here || !sameValue(a.v, b.v);
		})
		.map(keyOf);
}
