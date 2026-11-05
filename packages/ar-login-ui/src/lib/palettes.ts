/**
 * The palettes and templates a sign-in screen can use, as the server names them
 * (`pageTemplate.palette`, `pageTemplate.template`).
 *
 * The admin console keeps a mirror of the palette ids (`theme-palettes.ts`): an id there must be
 * one this file knows, or the real screens fall back to the default.
 *
 * The stylesheet is still keyed on the pre-palette names (`data-login-theme`, `data-page-layout`).
 * `legacyThemeFor` and `layoutFor` translate, so the existing rules keep painting the three
 * palettes they already cover, and `flat` is the one palette with rules of its own.
 */

export const PALETTE_IDS = ['meridian', 'classic', 'glass', 'flat'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export const DEFAULT_PALETTE: PaletteId = 'meridian';

export const TEMPLATE_IDS = ['standard', 'split', 'minimal'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const DEFAULT_TEMPLATE: TemplateId = 'standard';

/** The value `data-login-theme` takes: the four pre-palette names, plus `flat`. */
export type LegacyThemeName =
	| 'classic'
	| 'meridian'
	| 'split-brand-panel'
	| 'fullbleed-glass'
	| 'flat';

export function readPalette(value: unknown): PaletteId | null {
	return typeof value === 'string' && (PALETTE_IDS as readonly string[]).includes(value)
		? (value as PaletteId)
		: null;
}

export function readTemplate(value: unknown): TemplateId | null {
	return typeof value === 'string' && (TEMPLATE_IDS as readonly string[]).includes(value)
		? (value as TemplateId)
		: null;
}

/** The pre-palette theme name for a palette: the one whose rules paint that palette. */
export function legacyThemeFor(palette: PaletteId, template: TemplateId): LegacyThemeName {
	if (palette === 'classic') return 'classic';
	if (palette === 'glass') return 'fullbleed-glass';
	if (palette === 'flat') return 'flat';
	return template === 'split' ? 'split-brand-panel' : 'meridian';
}

/** The pre-template `data-page-layout` for a template. `minimal` shares the centred layout. */
export function layoutFor(template: TemplateId): 'centered_card' | 'split_panel' {
	return template === 'split' ? 'split_panel' : 'centered_card';
}

/**
 * The page background of each palette in each mode, as the stylesheet paints it: used before the
 * styles load, so the first frame does not flash another colour.
 */
export const PALETTE_BACKGROUNDS: Record<PaletteId, { light: string; dark: string }> = {
	meridian: { light: '#eef1f6', dark: '#0b0e16' },
	classic: { light: '#eeeae3', dark: '#0f0d0c' },
	glass: { light: '#ecdfd3', dark: '#0d0908' },
	flat: { light: '#ffffff', dark: '#0a0a0b' }
};
