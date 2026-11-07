/**
 * A saved theme's values (Login UI settings, keyed `login-ui.*`) and the editor's draft, both
 * ways. Saving writes the whole look the draft shows, so that applying the theme makes the
 * screens look as the editor does; colours and images left empty are not written (the template's
 * own apply). Reading starts from a new draft and takes each value that is valid, so a value the
 * editor does not know (written elsewhere) falls back to the editor's default.
 *
 * Saving a theme that was opened starts from its stored values (`base`): what the editor does not
 * edit is kept as it was (keys it has no control for, languages and texts it does not show, a
 * value it shows the same way as one it would write), so that changing a theme's name, or one of
 * its colours, changes nothing else of it.
 */
import type { ThemeValues } from '#lib/api/login-ui-themes.js';
import {
	formatLoginUIImageFilters,
	parseLoginUIImageFilters
} from '@authrim/ar-lib-core/utils/login-ui-image-filters';
import {
	newThemeDraft,
	SPLIT_CHOICES,
	TEXT_LANGUAGES,
	TOPBAR_POSITIONS,
	type BrandPanelDisplay,
	type ColourMode,
	type FontScale,
	type LogoDisplay,
	type TextLanguage,
	type ThemeDraft,
	type ThemeFont,
	type ThemeTemplate
} from './theme-draft';
import { PALETTE_IDS, type PaletteId } from './theme-palettes';

const KEY = (name: string) => `login-ui.${name}`;

/** The header's logo display, as the screens name it. */
const LOGO_DISPLAY: Record<LogoDisplay, string> = { both: 'auto', logo: 'image', name: 'text' };

/** Where an image goes, and the kind of asset it is uploaded as. */
export const THEME_IMAGES = [
	{ field: 'logo', key: 'logo_url', kind: 'logo' },
	{ field: 'favicon', key: 'favicon_url', kind: 'favicon' },
	{ field: 'backgroundImage', key: 'background_image_url', kind: 'background' },
	{ field: 'panelImage', key: 'brand_panel_image_url', kind: 'background' },
	{ field: 'cardImage', key: 'login_panel_background_image_url', kind: 'panel-background' }
] as const;

type ImageField = (typeof THEME_IMAGES)[number]['field'];

/** Which keys each control of the editor writes. */
const FIELD_KEYS: readonly (readonly [keyof ThemeDraft, readonly string[]])[] = [
	['template', ['template']],
	['palette', ['palette']],
	['mode', ['theme']],
	['font', ['font_family']],
	['fontScale', ['font_scale']],
	['topbarPosition', ['topbar_position']],
	['header', ['header_enabled']],
	['footer', ['footer_enabled']],
	['themeToggle', ['theme_toggle_enabled']],
	['languageSelect', ['language_select_enabled']],
	['brandName', ['brand_name']],
	['headerName', ['header_name']],
	['logoDisplay', ['logo_display']],
	['brandLogoDisplay', ['brand_content_mode', 'brand_panel_logo_display']],
	['panelTitle', ['brand_panel_title']],
	['panelText', ['brand_panel_text']],
	['splitFrame', ['split_frame']],
	['splitSide', ['split_panel_side']],
	['formFrame', ['form_frame']],
	['splitWidth', ['split_panel_width']],
	['brandPosition', ['brand_position']],
	['brandAlign', ['brand_align']],
	['backgroundOpacity', ['background_image_opacity']],
	['panelImageOpacity', ['brand_panel_image_opacity']],
	['cardImageOpacity', ['login_panel_background_opacity']],
	// Grayscale is one of the filters: the older switch is written off with them.
	['backgroundFilters', ['background_image_filters', 'background_image_grayscale']],
	['panelImageGrayscale', ['brand_panel_image_grayscale']],
	['cardImageGrayscale', ['login_panel_background_grayscale']],
	['customCss', ['custom_css']],
	['background', ['background_color']],
	['cardColor', ['form_area_color']],
	['accent', ['accent_color']],
	['titleColor', ['title_color']],
	['textColor', ['text_color']],
	['copyColor', ['copy_color']],
	['fieldColor', ['field_color']],
	['secondaryButtonColor', ['secondary_button_color']],
	...THEME_IMAGES.map((image) => [image.field, [image.key]] as const)
];

/** The keys the editor writes: any other key of a stored theme is kept as it is. */
const EDITED_KEYS: ReadonlySet<string> = new Set(
	[...FIELD_KEYS.flatMap(([, keys]) => keys), 'text_localizations'].map(KEY)
);

/** The values of a draft by itself (a new theme). */
function freshValues(draft: ThemeDraft): ThemeValues {
	const values: ThemeValues = {
		[KEY('template')]: draft.template,
		[KEY('palette')]: draft.palette,
		[KEY('theme')]: draft.mode,
		[KEY('font_family')]: draft.font,
		[KEY('font_scale')]: draft.fontScale,
		[KEY('topbar_position')]: draft.topbarPosition,
		[KEY('header_enabled')]: draft.header,
		[KEY('footer_enabled')]: draft.footer,
		[KEY('theme_toggle_enabled')]: draft.themeToggle,
		[KEY('language_select_enabled')]: draft.languageSelect,
		[KEY('brand_name')]: draft.brandName,
		[KEY('header_name')]: draft.headerName,
		[KEY('logo_display')]: LOGO_DISPLAY[draft.logoDisplay],
		[KEY('brand_panel_title')]: draft.panelTitle,
		[KEY('brand_panel_text')]: draft.panelText,
		[KEY('split_frame')]: draft.splitFrame,
		[KEY('split_panel_side')]: draft.splitSide,
		[KEY('form_frame')]: draft.formFrame,
		[KEY('split_panel_width')]: draft.splitWidth,
		[KEY('brand_position')]: draft.brandPosition,
		[KEY('brand_align')]: draft.brandAlign,
		[KEY('background_image_opacity')]: draft.backgroundOpacity,
		[KEY('brand_panel_image_opacity')]: draft.panelImageOpacity,
		[KEY('login_panel_background_opacity')]: draft.cardImageOpacity,
		[KEY('background_image_grayscale')]: false,
		[KEY('background_image_filters')]: formatLoginUIImageFilters(draft.backgroundFilters),
		[KEY('brand_panel_image_grayscale')]: draft.panelImageGrayscale,
		[KEY('login_panel_background_grayscale')]: draft.cardImageGrayscale,
		[KEY('custom_css')]: draft.customCss
	};
	// The brand panel shows nothing of the brand, or its logo display apart from the header's.
	if (draft.brandLogoDisplay === 'none') {
		values[KEY('brand_content_mode')] = 'none';
	} else {
		values[KEY('brand_content_mode')] = 'logo_copy';
		values[KEY('brand_panel_logo_display')] = LOGO_DISPLAY[draft.brandLogoDisplay];
	}
	const colours: [string, string][] = [
		['background_color', draft.background],
		['form_area_color', draft.cardColor],
		['accent_color', draft.accent],
		['title_color', draft.titleColor],
		['text_color', draft.textColor],
		['copy_color', draft.copyColor],
		['field_color', draft.fieldColor],
		['secondary_button_color', draft.secondaryButtonColor]
	];
	for (const [name, value] of colours) if (value) values[KEY(name)] = value;
	for (const image of THEME_IMAGES) {
		const value = draft[image.field];
		if (typeof value === 'string' && value) values[KEY(image.key)] = value;
	}
	const localizations: Record<string, Record<string, unknown>> = {};
	for (const { value: language } of TEXT_LANGUAGES) {
		localizations[language] = textEntry({}, draft.texts[language]);
	}
	values[KEY('text_localizations')] = JSON.stringify(localizations);
	return values;
}

/** A language's texts as the editor writes them, over what the language held. */
function textEntry(
	entry: Record<string, unknown>,
	texts: { tagline: string; footer: string },
	only?: { tagline: boolean; footer: boolean }
): Record<string, unknown> {
	const next = { ...entry };
	if (!only || only.tagline) {
		if (texts.tagline) next.tagline = texts.tagline;
		else delete next.tagline;
	}
	// An empty footer is kept: it hides the default one, which the language would show.
	if (!only || only.footer) next.footerText = texts.footer;
	return next;
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** A stored theme being edited: its values, and the draft they showed as when last read or saved. */
export interface StoredTheme {
	values: ThemeValues;
	opened: ThemeDraft;
}

/** A stored theme as it is opened. */
export const openStored = (values: ThemeValues): StoredTheme => ({
	values,
	opened: valuesToDraft(values)
});

/**
 * The values a draft saves: by itself for a new theme, or over a stored theme (`stored`). Images
 * must already be URLs (see `uploadThemeImages`).
 */
export function draftToValues(draft: ThemeDraft, stored?: StoredTheme): ThemeValues {
	const fresh = freshValues(draft);
	if (!stored) return fresh;
	// What the admin has not changed since the theme was opened (or last saved) is written back as
	// it was stored, a key it did not have included; what was changed is written as a new theme
	// would write it.
	const { values: base, opened } = stored;
	const values: ThemeValues = Object.fromEntries(
		Object.entries(base).filter(([key]) => !EDITED_KEYS.has(key))
	);
	for (const [field, names] of FIELD_KEYS) {
		const from = same(draft[field], opened[field]) ? base : fresh;
		for (const key of names.map(KEY)) if (key in from) values[key] = from[key];
	}
	// A panel showing the logo alone (no copy) stays so: the editor has no control for it.
	if (
		base[KEY('brand_content_mode')] === 'logo' &&
		values[KEY('brand_content_mode')] === 'logo_copy'
	) {
		values[KEY('brand_content_mode')] = 'logo';
	}
	// The texts: the ones not changed are kept as stored (an empty one, or none, included).
	const textsChanged = TEXT_LANGUAGES.some(
		({ value: language }) => !same(draft.texts[language], opened.texts[language])
	);
	if (!textsChanged) {
		if (KEY('text_localizations') in base) {
			values[KEY('text_localizations')] = base[KEY('text_localizations')];
		}
		return values;
	}
	const localizations = localizationsOf(base[KEY('text_localizations')]);
	for (const { value: language } of TEXT_LANGUAGES) {
		const now = draft.texts[language];
		const then = opened.texts[language];
		const only = { tagline: now.tagline !== then.tagline, footer: now.footer !== then.footer };
		if (!only.tagline && !only.footer) continue;
		localizations[language] = textEntry(localizations[language] ?? {}, now, only);
	}
	values[KEY('text_localizations')] = JSON.stringify(localizations);
	return values;
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
	typeof value === 'string' && (allowed as readonly string[]).includes(value)
		? (value as T)
		: fallback;
const textOf = (value: unknown, fallback: string): string =>
	typeof value === 'string' ? value : fallback;
const flagOf = (value: unknown, fallback: boolean): boolean =>
	typeof value === 'boolean' ? value : fallback;
const percentOf = (value: unknown, fallback: number): number =>
	typeof value === 'number' && Number.isFinite(value)
		? Math.min(100, Math.max(0, Math.round(value)))
		: fallback;

function logoDisplayOf(value: unknown, fallback: LogoDisplay): LogoDisplay {
	switch (value) {
		case 'auto':
			return 'both';
		case 'image':
			return 'logo';
		case 'text':
		case 'hidden':
			return 'name';
		default:
			return fallback;
	}
}

function localizationsOf(value: unknown): Record<string, Record<string, unknown>> {
	if (typeof value !== 'string' || !value.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, Record<string, unknown>>)
			: {};
	} catch {
		return {};
	}
}

/** The draft a saved theme opens as. */
export function valuesToDraft(values: ThemeValues): ThemeDraft {
	const draft = newThemeDraft();
	const v = (name: string) => values[KEY(name)];
	draft.template = oneOf<ThemeTemplate>(
		v('template'),
		['standard', 'split', 'minimal'],
		draft.template
	);
	draft.palette = oneOf<PaletteId>(v('palette'), PALETTE_IDS, draft.palette);
	draft.mode = oneOf<ColourMode>(v('theme'), ['auto', 'light', 'dark'], draft.mode);
	draft.font = oneOf<ThemeFont>(
		v('font_family'),
		['system', 'serif', 'rounded', 'mono'],
		draft.font
	);
	draft.fontScale = oneOf<FontScale>(
		v('font_scale'),
		['compact', 'comfortable', 'spacious'],
		draft.fontScale
	);
	draft.topbarPosition = oneOf(v('topbar_position'), TOPBAR_POSITIONS, draft.topbarPosition);
	draft.header = flagOf(v('header_enabled'), draft.header);
	draft.footer = flagOf(v('footer_enabled'), draft.footer);
	draft.themeToggle = flagOf(v('theme_toggle_enabled'), draft.themeToggle);
	draft.languageSelect = flagOf(v('language_select_enabled'), draft.languageSelect);
	draft.brandName = textOf(v('brand_name'), draft.brandName);
	draft.headerName = textOf(v('header_name'), draft.headerName);
	draft.logoDisplay = logoDisplayOf(v('logo_display'), draft.logoDisplay);
	const panelDisplay = v('brand_panel_logo_display');
	draft.brandLogoDisplay =
		v('brand_content_mode') === 'none'
			? 'none'
			: panelDisplay === 'hidden'
				? 'none'
				: panelDisplay === 'inherit' || panelDisplay === undefined
					? (draft.logoDisplay as BrandPanelDisplay)
					: logoDisplayOf(panelDisplay, draft.brandLogoDisplay as LogoDisplay);
	draft.panelTitle = textOf(v('brand_panel_title'), draft.panelTitle);
	draft.panelText = textOf(v('brand_panel_text'), draft.panelText);
	draft.splitFrame = oneOf(v('split_frame'), SPLIT_CHOICES.splitFrame, draft.splitFrame);
	draft.splitSide = oneOf(v('split_panel_side'), SPLIT_CHOICES.splitSide, draft.splitSide);
	draft.formFrame = oneOf(v('form_frame'), SPLIT_CHOICES.formFrame, draft.formFrame);
	draft.splitWidth = oneOf(v('split_panel_width'), SPLIT_CHOICES.splitWidth, draft.splitWidth);
	draft.brandPosition = oneOf(
		v('brand_position'),
		SPLIT_CHOICES.brandPosition,
		draft.brandPosition
	);
	draft.brandAlign = oneOf(v('brand_align'), SPLIT_CHOICES.brandAlign, draft.brandAlign);
	draft.background = textOf(v('background_color'), '');
	draft.cardColor = textOf(v('form_area_color'), '');
	draft.accent = textOf(v('accent_color'), '');
	draft.titleColor = textOf(v('title_color'), '');
	draft.textColor = textOf(v('text_color'), '');
	draft.copyColor = textOf(v('copy_color'), '');
	draft.fieldColor = textOf(v('field_color'), '');
	draft.secondaryButtonColor = textOf(v('secondary_button_color'), '');
	draft.backgroundOpacity = percentOf(v('background_image_opacity'), draft.backgroundOpacity);
	draft.panelImageOpacity = percentOf(v('brand_panel_image_opacity'), draft.panelImageOpacity);
	draft.cardImageOpacity = percentOf(v('login_panel_background_opacity'), draft.cardImageOpacity);
	draft.backgroundFilters = parseLoginUIImageFilters(v('background_image_filters'));
	// A theme saved with the older grayscale switch shows it as a full grayscale filter, first (the
	// switch's tone is laid before any filter), unless it has a grayscale filter of its own.
	if (
		flagOf(v('background_image_grayscale'), false) &&
		!draft.backgroundFilters.some((filter) => filter.name === 'grayscale')
	) {
		draft.backgroundFilters.unshift({ name: 'grayscale', value: 100 });
	}
	draft.panelImageGrayscale = flagOf(v('brand_panel_image_grayscale'), draft.panelImageGrayscale);
	draft.cardImageGrayscale = flagOf(
		v('login_panel_background_grayscale'),
		draft.cardImageGrayscale
	);
	draft.customCss = textOf(v('custom_css'), '');
	for (const image of THEME_IMAGES) {
		const url = v(image.key);
		draft[image.field as ImageField] = typeof url === 'string' && url ? url : null;
	}
	const localizations = localizationsOf(v('text_localizations'));
	for (const { value: language } of TEXT_LANGUAGES) {
		const entry = localizations[language as TextLanguage] ?? {};
		if (typeof entry.tagline === 'string') draft.texts[language].tagline = entry.tagline;
		if (typeof entry.footerText === 'string') draft.texts[language].footer = entry.footerText;
	}
	return draft;
}

/**
 * Upload the images the admin chose (files) and put their URLs in their place, so that the draft
 * can be saved. Images already stored (URLs) and empty ones are left as they are.
 */
export async function uploadThemeImages(
	draft: ThemeDraft,
	upload: (kind: string, file: File) => Promise<string>
): Promise<ThemeDraft> {
	const next = { ...draft };
	for (const image of THEME_IMAGES) {
		const value = draft[image.field];
		if (value instanceof File) next[image.field] = await upload(image.kind, value);
	}
	return next;
}
