import type { ScreenKind, ScreenListItem } from '#lib/api/screens.js';
import type { LayoutRow } from '#lib/ui/builder/layout-model.js';
import type { Translations } from '#lib/ui/builder/TranslationTable.svelte';
import { textId } from './screen-builder';
import { fieldsToBuilder, legacyYesNoIds } from './screen-layout';
import type { ChoiceSource, DisplayCondition, PartSettings } from './screen-model';
import { localizationsToTranslations, SCREEN_TEXT } from './screen-texts';

/** The screen parts shown inside either preview's theme frame. */
export interface ScreenPreviewContent {
	id: string;
	label: string;
	canvas: 'narrow' | 'wide';
	rows: readonly LayoutRow[];
	settings: Record<string, PartSettings>;
	rowSettings: Record<string, DisplayCondition>;
	choices?: ChoiceSource;
	legacyYesNo?: ReadonlySet<string>;
	translations?: Translations;
}

/** A saved screen, including its translations, ready for the theme editor's picker. */
export function savedScreenPreview(screen: ScreenListItem): ScreenPreviewContent {
	let next = 0;
	const read = fieldsToBuilder(screen.fields, (prefix) => `${screen.id}-${prefix}-${++next}`);
	return {
		id: screen.id,
		label: screen.display_name,
		canvas: screen.settings.canvas_layout === 'wide' ? 'wide' : 'narrow',
		rows: read.rows,
		settings: read.settings,
		rowSettings: read.rowSettings,
		legacyYesNo: legacyYesNoIds(read.origins),
		translations: localizationsToTranslations(screen.localizations, screen.fields, read)
	};
}

/** The theme picker shows these screen kinds in this order, keeping list order within each kind. */
const THEME_PREVIEW_KINDS = [
	'registration',
	'login',
	'profile_completion'
] as const satisfies readonly ScreenKind[];

export function themeScreenPreviews(
	screens: readonly ScreenListItem[],
	choices?: ChoiceSource
): ScreenPreviewContent[] {
	const eligible = screens.filter((screen) =>
		THEME_PREVIEW_KINDS.some((kind) => kind === screen.screen_kind)
	);
	const saved = eligible.filter((screen) => !screen.is_system);
	const offered = saved.length > 0 ? saved : eligible.filter((screen) => screen.is_system);
	return THEME_PREVIEW_KINDS.flatMap((kind) =>
		offered
			.filter((screen) => screen.screen_kind === kind)
			.map((screen) => ({ ...savedScreenPreview(screen), choices }))
	);
}

/** Apply the preview language without changing the screen draft or its saved fields. */
export function localizedScreenPreview(content: ScreenPreviewContent, language: string) {
	const translated = (id: string) => content.translations?.[id]?.[language];
	return {
		label: translated(SCREEN_TEXT.name) || content.label,
		rows: content.rows.map((row) => ({
			...row,
			columns: row.columns.map((column) =>
				column.map((part) => ({
					...part,
					label: translated(textId.label(part.id)) || part.label
				}))
			)
		})),
		settings: Object.fromEntries(
			Object.entries(content.settings).map(([id, settings]) => [
				id,
				{
					...settings,
					text: translated(textId.text(id)) || settings.text,
					placeholder: translated(textId.placeholder(id)) || settings.placeholder,
					helpText: translated(textId.helpText(id)) || settings.helpText,
					options: settings.options.map((option) => ({
						...option,
						label: translated(textId.option(id, option.value)) || option.label
					}))
				}
			])
		) as Record<string, PartSettings>
	};
}
