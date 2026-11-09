/**
 * The colours a theme sets, in the order the editor lists them: the draft field of each (its
 * light-mode value), its name in the shared colour module (its setting and its dark-mode value),
 * its label, and the colour in effect while it is not set (the palette's, in the mode shown).
 */
import type { MessageKey } from '#lib/i18n/messages/ja.js';
import type { LoginUIThemeColorName } from '@authrim/ar-lib-core/utils/login-ui-theme-colors';
import type { ThemeDraft } from './theme-draft';
import type { PaletteColours } from './theme-palettes';

/** A transparent colour, for the swatch of a bar that has no fill of its own. */
export const NO_FILL = '#00000000';

export type ThemeColourField =
	| 'background'
	| 'cardColor'
	| 'brandPanelBackground'
	| 'accent'
	| 'linkColor'
	| 'titleColor'
	| 'textColor'
	| 'copyColor'
	| 'fieldColor'
	| 'secondaryButtonColor'
	| 'themeToggleBackground'
	| 'languageSelectBackground'
	| 'headerBackground'
	| 'headerText'
	| 'footerBackground'
	| 'footerText';

export interface ThemeColour {
	field: ThemeColourField;
	name: LoginUIThemeColorName;
	label: MessageKey;
	/** Offers an opacity slider. The main button takes none: its label colour is chosen against it. */
	alpha: boolean;
	/** The colour in effect while none is set. */
	fallback: (palette: PaletteColours) => string;
	/**
	 * Read as the shared colour module checks it (as the Admin API reads it), so a value the screens
	 * would drop is not shown here either. The older colours keep the wider rule they always had.
	 */
	strict?: boolean;
}

export const THEME_COLOURS: readonly ThemeColour[] = [
	{
		field: 'background',
		name: 'background',
		label: 'th.c.background',
		alpha: true,
		fallback: (p) => p.background
	},
	{
		field: 'cardColor',
		name: 'form_area',
		label: 'th.c.card',
		alpha: true,
		fallback: (p) => p.card
	},
	{
		field: 'brandPanelBackground',
		name: 'brand_panel_background',
		label: 'th.c.brandPanelBackground',
		alpha: true,
		fallback: () => '#090d1e61',
		strict: true
	},
	{
		field: 'accent',
		name: 'accent',
		label: 'th.c.accent',
		alpha: false,
		fallback: (p) => p.accent
	},
	{
		field: 'linkColor',
		name: 'link',
		label: 'th.c.link',
		alpha: true,
		fallback: (p) => p.accent,
		strict: true
	},
	{
		field: 'titleColor',
		name: 'title',
		label: 'th.c.title',
		alpha: true,
		fallback: (p) => p.title
	},
	{ field: 'textColor', name: 'text', label: 'th.c.text', alpha: true, fallback: (p) => p.text },
	{ field: 'copyColor', name: 'copy', label: 'th.c.copy', alpha: true, fallback: (p) => p.copy },
	{ field: 'fieldColor', name: 'field', label: 'th.c.field', alpha: true, fallback: (p) => p.card },
	{
		field: 'secondaryButtonColor',
		name: 'secondary_button',
		label: 'th.c.secondaryButton',
		alpha: true,
		fallback: (p) => p.card
	},
	{
		field: 'themeToggleBackground',
		name: 'theme_toggle_background',
		label: 'th.c.themeToggleBackground',
		alpha: true,
		fallback: (p) => p.card,
		strict: true
	},
	{
		field: 'languageSelectBackground',
		name: 'language_select_background',
		label: 'th.c.languageSelectBackground',
		alpha: true,
		fallback: (p) => p.card,
		strict: true
	},
	{
		field: 'headerBackground',
		name: 'header_background',
		label: 'th.c.headerBackground',
		alpha: true,
		fallback: () => NO_FILL,
		strict: true
	},
	{
		field: 'headerText',
		name: 'header_text',
		label: 'th.c.headerText',
		alpha: true,
		fallback: (p) => p.title,
		strict: true
	},
	{
		field: 'footerBackground',
		name: 'footer_background',
		label: 'th.c.footerBackground',
		alpha: true,
		fallback: () => NO_FILL,
		strict: true
	},
	{
		field: 'footerText',
		name: 'footer_text',
		label: 'th.c.footerText',
		alpha: true,
		fallback: (p) => p.copy,
		strict: true
	}
];

/** A colour as the draft sets it in a mode: its own value, or its dark-mode value; '' = not set. */
export function draftColour(
	draft: ThemeDraft,
	colour: Pick<ThemeColour, 'field' | 'name'>,
	scheme: 'light' | 'dark'
): string {
	return scheme === 'dark' ? (draft.darkColours[colour.name] ?? '') : draft[colour.field];
}

/** Sets a colour of the draft in a mode ('' takes it back to the palette's). */
export function setDraftColour(
	draft: ThemeDraft,
	colour: Pick<ThemeColour, 'field' | 'name'>,
	scheme: 'light' | 'dark',
	value: string
): void {
	if (scheme === 'light') {
		draft[colour.field] = value;
		return;
	}
	const next = { ...draft.darkColours };
	if (value) next[colour.name] = value;
	else delete next[colour.name];
	draft.darkColours = next;
}
