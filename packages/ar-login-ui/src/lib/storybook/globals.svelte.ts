/**
 * Toolbar selections shared with every Login UI frame.
 *
 * `.storybook/preview.ts` writes here when the toolbar changes; `LoginUIFrame` reads from here.
 * A frame that is given an explicit prop (a gallery cell) ignores the toolbar for that choice.
 */
import type { LoginUILocale } from '#lib/i18n/locales.js';
import {
	DEFAULT_PALETTE,
	DEFAULT_TEMPLATE,
	PALETTE_IDS,
	TEMPLATE_IDS,
	readPalette,
	readTemplate,
	type PaletteId,
	type TemplateId
} from '#lib/palettes.js';

/**
 * The two toolbar choices a tenant makes: the structure of the page (template) and the colours
 * (palette). They combine freely, as in the Admin console's Themes page.
 */
export const TEMPLATES = TEMPLATE_IDS;
export const PALETTES = PALETTE_IDS;
export const TEMPLATE_LABELS: Record<TemplateId, string> = {
	standard: 'Standard (default)',
	split: 'Split',
	minimal: 'Minimal'
};
export const PALETTE_LABELS: Record<PaletteId, string> = {
	meridian: 'Meridian (default)',
	classic: 'Classic',
	glass: 'Glass',
	flat: 'Flat'
};

/**
 * The four pre-palette theme names. The toolbar no longer offers them; the galleries
 * (`Themes and layouts`) still pin a frame to one with the `theme` prop.
 */
export const THEME_TEMPLATES = [
	'meridian',
	'classic',
	'split-brand-panel',
	'fullbleed-glass'
] as const;
export type ThemeTemplate = (typeof THEME_TEMPLATES)[number];

export type Scheme = 'light' | 'dark';

export const THEME_TEMPLATE_LABELS: Record<ThemeTemplate, string> = {
	meridian: 'Meridian (default)',
	classic: 'Classic',
	'split-brand-panel': 'Split brand panel',
	'fullbleed-glass': 'Full-bleed glass'
};

export const sbGlobals = $state<{
	template: TemplateId;
	palette: PaletteId;
	scheme: Scheme;
	locale: LoginUILocale;
}>({ template: DEFAULT_TEMPLATE, palette: DEFAULT_PALETTE, scheme: 'light', locale: 'ja' });

export function isThemeTemplate(value: unknown): value is ThemeTemplate {
	return (THEME_TEMPLATES as readonly unknown[]).includes(value);
}

/** A toolbar value, or the default when it is not one the Login UI knows. */
export function templateFrom(value: unknown): TemplateId {
	return readTemplate(value) ?? DEFAULT_TEMPLATE;
}
export function paletteFrom(value: unknown): PaletteId {
	return readPalette(value) ?? DEFAULT_PALETTE;
}
