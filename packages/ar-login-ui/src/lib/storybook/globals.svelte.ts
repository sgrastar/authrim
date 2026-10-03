/**
 * Toolbar selections shared with every Login UI frame.
 *
 * `.storybook/preview.ts` writes here when the toolbar changes; `LoginUIFrame` reads from here.
 * A frame that is given an explicit prop (an "All themes" gallery cell) ignores the toolbar.
 */
import type { LoginUILocale } from '$lib/i18n/locales';

export const THEME_TEMPLATES = [
	'meridian',
	'classic',
	'split-brand-panel',
	'fullbleed-glass'
] as const;
export type ThemeTemplate = (typeof THEME_TEMPLATES)[number];

export const LIGHT_VARIANT_IDS = ['beige', 'blue-gray', 'green'] as const;
export const DARK_VARIANT_IDS = ['brown', 'navy', 'slate'] as const;

export type Scheme = 'light' | 'dark';

export const THEME_TEMPLATE_LABELS: Record<ThemeTemplate, string> = {
	meridian: 'Meridian (default)',
	classic: 'Classic',
	'split-brand-panel': 'Split brand panel',
	'fullbleed-glass': 'Full-bleed glass'
};

export const sbGlobals = $state<{
	theme: ThemeTemplate;
	scheme: Scheme;
	/** `default` keeps the first variant of the scheme. */
	variant: string;
	locale: LoginUILocale;
}>({ theme: 'meridian', scheme: 'light', variant: 'default', locale: 'ja' });

export function isThemeTemplate(value: unknown): value is ThemeTemplate {
	return (THEME_TEMPLATES as readonly unknown[]).includes(value);
}
