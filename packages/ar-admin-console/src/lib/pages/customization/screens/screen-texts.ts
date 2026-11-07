/**
 * A screen's translations as saved (`localizations[locale].fields[block id]`, with the screen's own
 * name and description) and as the translation table edits them (by text id, then locale).
 *
 * The Login UI finds a part's translation by its block id, or, for a part saved without one, by
 * `<field>-<index>` (its place in the saved list): such a part is given an id when it is read
 * (`fieldsToBuilder`), and its translations follow it.
 */
import type { ScreenField, ScreenLocalization } from '@authrim/ar-lib-core/types/screens';
import type { Translations } from '#lib/ui/builder/TranslationTable.svelte';
import type { BuilderScreen } from './screen-layout';
import { textId } from './screen-builder';

/** The ids of the screen's own texts in the translations. */
export const SCREEN_TEXT = { name: 'screen.display_name', description: 'screen.description' };

type FieldTexts = NonNullable<ScreenLocalization['fields']>[string];

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);

function put(into: Translations, id: string, locale: string, value: unknown) {
	if (typeof value !== 'string' || !value) return;
	(into[id] ??= {})[locale] = value;
}

/** The key the Login UI looks a saved part's translation up by. */
function savedKey(field: ScreenField, index: number): string {
	return field.block_id || `${field.field || 'field'}-${index}`;
}

/** The saved translations, by the builder's text ids. */
export function localizationsToTranslations(
	localizations: Readonly<Record<string, ScreenLocalization>>,
	saved: readonly ScreenField[],
	screen: BuilderScreen
): Translations {
	// The builder's id of each saved part, by the key its translations are saved under.
	const idByKey = new Map<string, string>();
	for (const [id, origin] of Object.entries(screen.origins)) {
		const index = saved.indexOf(origin);
		if (index >= 0) idByKey.set(savedKey(origin, index), id);
	}
	const dividers = new Set(
		screen.rows
			.flatMap((row) => row.columns.flat())
			.filter((part) => part.kind === 'divider')
			.map((part) => part.id)
	);
	const translations: Translations = {};
	for (const [locale, localization] of Object.entries(localizations)) {
		if (!isRecord(localization)) continue;
		put(translations, SCREEN_TEXT.name, locale, localization.display_name);
		put(translations, SCREEN_TEXT.description, locale, localization.description);
		for (const [key, texts] of Object.entries(localization.fields ?? {})) {
			const id = idByKey.get(key);
			if (!id || !isRecord(texts)) continue;
			// A divider's shown words are its `text`, edited as its label.
			if (dividers.has(id)) {
				put(translations, textId.label(id), locale, texts.text);
				continue;
			}
			put(translations, textId.label(id), locale, texts.label);
			put(translations, textId.text(id), locale, texts.text);
			put(translations, textId.placeholder(id), locale, texts.placeholder);
			put(translations, textId.helpText(id), locale, texts.help_text);
			if (isRecord(texts.options)) {
				for (const [value, label] of Object.entries(texts.options)) {
					put(translations, textId.option(id, value), locale, label);
				}
			}
		}
	}
	return translations;
}

/**
 * The translations as saved: by locale, the screen's name and description and each part's texts
 * under its block id. Only texts the screen still has are kept, and only those translated.
 */
export function translationsToLocalizations(
	translations: Readonly<Translations>,
	screen: Pick<BuilderScreen, 'rows' | 'settings'>
): Record<string, ScreenLocalization> {
	const localizations: Record<string, ScreenLocalization> = {};
	const at = (locale: string) => (localizations[locale] ??= {});
	const each = (id: string, take: (locale: string, value: string) => void) => {
		for (const [locale, value] of Object.entries(translations[id] ?? {})) {
			if (typeof value === 'string' && value.trim()) take(locale, value.trim());
		}
	};
	each(SCREEN_TEXT.name, (locale, value) => (at(locale).display_name = value));
	each(SCREEN_TEXT.description, (locale, value) => (at(locale).description = value));
	for (const part of screen.rows.flatMap((row) => row.columns.flat())) {
		const field = (locale: string): FieldTexts => ((at(locale).fields ??= {})[part.id] ??= {});
		if (part.kind === 'divider') {
			each(textId.label(part.id), (locale, value) => (field(locale).text = value));
			continue;
		}
		each(textId.label(part.id), (locale, value) => (field(locale).label = value));
		each(textId.text(part.id), (locale, value) => (field(locale).text = value));
		each(textId.placeholder(part.id), (locale, value) => (field(locale).placeholder = value));
		each(textId.helpText(part.id), (locale, value) => (field(locale).help_text = value));
		for (const option of screen.settings[part.id]?.options ?? []) {
			each(textId.option(part.id, option.value), (locale, value) => {
				(field(locale).options ??= {})[option.value] = value;
			});
		}
	}
	return localizations;
}
