/**
 * The Login UI page's languages: the Settings API's `login-ui` values as the page edits them, and
 * back. The screens' language settings are four settings of one category:
 *   supported_locales            — the languages shown, as codes separated by commas
 *   default_locale               — the one used when the browser's matches none
 *   primary_locales              — the ones listed first (a JSON array), or null: the most
 *                                  spoken of those shown, chosen by the screens
 *   show_english_language_names  — "Japanese (日本語)" in the language switch
 * and, with them, the lite Login UI's logo (`lite_logo`, a small image as a data: URI) and the
 * custom content blocks (`custom_blocks`, a JSON array; `login-ui-custom-blocks.ts`), which the
 * page saves the same way. The lite mode itself has its own route (LiteLoginUiCard).
 * The page shows the saved values and never corrects one on its own: only what the admin changes
 * is sent. The default language counts as shown (the grid locks it on), so saving the languages
 * shown always includes it.
 */
import {
	isLoginUILocale,
	LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD,
	LOGIN_UI_LOCALES,
	MAX_LOGIN_UI_PRIMARY_LOCALES,
	parseConfiguredPrimaryLoginUILocales,
	selectDefaultPrimaryLoginUILocales,
	type LoginUILocale
} from '@authrim/ar-lib-core/types/login-ui-languages';
import { parseBlocks, serializeBlocks, type CustomBlock } from './login-ui-custom-blocks';

export const KEYS = {
	shown: 'login-ui.supported_locales',
	defaultLang: 'login-ui.default_locale',
	first: 'login-ui.primary_locales',
	englishNames: 'login-ui.show_english_language_names',
	liteLogo: 'login-ui.lite_logo',
	customBlocks: 'login-ui.custom_blocks'
} as const;

export type LanguageField = keyof typeof KEYS;

export interface LanguageValues {
	shown: LoginUILocale[];
	defaultLang: LoginUILocale;
	/** The languages listed first; null while the screens choose them (the most spoken shown). */
	first: LoginUILocale[] | null;
	englishNames: boolean;
	/** The lite Login UI's logo as a data: URI; '' for none. */
	liteLogo: string;
	/** The tenant's own content blocks around the screens. */
	customBlocks: CustomBlock[];
}

/** From how many languages shown the switch groups them, listing some first. */
export const FIRST_FROM = LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD;
export const FIRST_MAX = MAX_LOGIN_UI_PRIMARY_LOCALES;

/** The languages the screens know, in their canonical order. */
export const LOCALES: readonly LoginUILocale[] = LOGIN_UI_LOCALES;

/** Language codes out of a comma-separated list: the known ones, once each, in canonical order. */
export function parseShown(value: unknown): LoginUILocale[] {
	const listed = new Set(
		String(value ?? '')
			.split(',')
			.map((code) => code.trim())
			.filter(isLoginUILocale)
	);
	return LOCALES.filter((code) => listed.has(code));
}

/** The saved default language; English (the setting's own default) when the saved one is unknown. */
export function parseDefault(value: unknown): LoginUILocale {
	return isLoginUILocale(value) ? value : 'en';
}

/** The languages shown with the default among them, in canonical order. */
export function shownWithDefault(
	values: Pick<LanguageValues, 'shown' | 'defaultLang'>
): LoginUILocale[] {
	return LOCALES.filter((code) => code === values.defaultLang || values.shown.includes(code));
}

/** The saved choice of languages listed first, limited to those shown; null when the screens choose. */
export function parseFirst(
	value: unknown,
	shown: readonly LoginUILocale[]
): LoginUILocale[] | null {
	const chosen = parseConfiguredPrimaryLoginUILocales(value);
	return chosen && chosen.filter((code) => shown.includes(code)).slice(0, FIRST_MAX);
}

/** The languages the screens list first while none is chosen: the most spoken of those shown. */
export function automaticFirst(shown: readonly LoginUILocale[]): LoginUILocale[] {
	return selectDefaultPrimaryLoginUILocales(shown);
}

export function valuesFrom(values: Record<string, unknown>): LanguageValues {
	const shown = parseShown(values[KEYS.shown]);
	const defaultLang = parseDefault(values[KEYS.defaultLang]);
	return {
		shown,
		defaultLang,
		// Limited to what is shown with the default among it, as the grid offers it.
		first: parseFirst(values[KEYS.first], shownWithDefault({ shown, defaultLang })),
		englishNames: values[KEYS.englishNames] === true,
		liteLogo: typeof values[KEYS.liteLogo] === 'string' ? (values[KEYS.liteLogo] as string) : '',
		customBlocks: parseBlocks(values[KEYS.customBlocks])
	};
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
	a === null || b === null ? a === b : a.join(',') === b.join(',');

/**
 * The settings to send: only what changed, as the API stores each. Settings in `fixed` (the
 * platform's, or ones the admin may not change) are never sent, whatever the screen holds.
 */
export function changesBetween(
	saved: LanguageValues,
	screen: LanguageValues,
	fixed: ReadonlySet<string> = new Set()
): Record<string, unknown> {
	const set: Record<string, unknown> = {};
	// The default counts as shown on both sides: only the admin's own change is sent.
	const shown = shownWithDefault(screen);
	if (!sameList(shown, shownWithDefault(saved))) set[KEYS.shown] = shown.join(',');
	if (screen.defaultLang !== saved.defaultLang) set[KEYS.defaultLang] = screen.defaultLang;
	const first =
		screen.first && screen.first.filter((code) => shown.includes(code)).slice(0, FIRST_MAX);
	if (!sameList(first, saved.first)) set[KEYS.first] = first;
	if (screen.englishNames !== saved.englishNames) set[KEYS.englishNames] = screen.englishNames;
	if (screen.liteLogo !== saved.liteLogo) set[KEYS.liteLogo] = screen.liteLogo;
	const blocks = serializeBlocks(screen.customBlocks);
	if (blocks !== serializeBlocks(saved.customBlocks)) set[KEYS.customBlocks] = blocks;
	for (const key of fixed) delete set[key];
	return set;
}

/** The field of a setting key, to carry a value from one screen state to another. */
export function fieldOfKey(key: string): LanguageField | undefined {
	return (Object.keys(KEYS) as LanguageField[]).find((field) => KEYS[field] === key);
}
