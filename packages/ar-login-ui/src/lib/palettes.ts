/**
 * The palettes and templates a sign-in screen can use, as the server names them
 * (`pageTemplate.palette`, `pageTemplate.template`).
 *
 * The admin console keeps a mirror of the palette ids (`theme-palettes.ts`): an id there must be
 * one this file knows, or the real screens fall back to the default.
 *
 * `legacyThemeFor` and `layoutFor` select the stylesheet rules for each palette and template.
 */

export const PALETTE_IDS = ['clean', 'classic', 'swiss-grid', 'glass', 'clear-glass'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
export const DEFAULT_PALETTE: PaletteId = 'clean';

export const TEMPLATE_IDS = ['standard', 'split', 'minimal'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const DEFAULT_TEMPLATE: TemplateId = 'standard';

/** The CSS selector name used for a palette, with the named split preset also supported. */
export type LegacyThemeName =
	| 'classic'
	| 'clean'
	| 'split-brand-panel'
	| 'swiss-grid'
	| 'glass'
	| 'clear-glass';

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

/** The CSS theme selector whose rules paint this palette. */
export function legacyThemeFor(palette: PaletteId): LegacyThemeName {
	if (palette === 'classic') return 'classic';
	if (palette === 'swiss-grid') return 'swiss-grid';
	if (palette === 'glass') return 'glass';
	if (palette === 'clear-glass') return 'clear-glass';
	return 'clean';
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
	clean: { light: '#ffffff', dark: '#0a0a0b' },
	classic: { light: '#eeeae3', dark: '#0f0d0c' },
	'swiss-grid': { light: '#f6f5f1', dark: '#121210' },
	glass: { light: '#e9ecf2', dark: '#14161b' },
	'clear-glass': { light: '#dce3e9', dark: '#111419' }
};
