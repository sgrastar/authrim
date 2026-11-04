import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

/**
 * What the Themes page edits, by section: one tab each. The settings in a section are the legacy
 * Admin UI theme page's (`login-ui.*`).
 */
export interface ThemeSection {
	id: 'look' | 'brand' | 'text' | 'images' | 'advanced';
	tab: MessageKey;
}

export const THEME_SECTIONS: readonly ThemeSection[] = [
	{ id: 'look', tab: 'th.tab.look' },
	{ id: 'brand', tab: 'th.tab.brand' },
	{ id: 'text', tab: 'th.tab.text' },
	{ id: 'images', tab: 'th.tab.images' },
	{ id: 'advanced', tab: 'th.tab.advanced' }
];

/** The screens the preview can show, in the order the end user meets them. */
export const PREVIEW_SCREENS = [
	{ value: 'signIn', label: 'th.screen.signIn' },
	{ value: 'signUp', label: 'th.screen.signUp' },
	{ value: 'code', label: 'th.screen.code' },
	{ value: 'consent', label: 'th.screen.consent' },
	{ value: 'error', label: 'th.screen.error' }
] as const satisfies readonly { value: string; label: MessageKey }[];

export type PreviewScreen = (typeof PREVIEW_SCREENS)[number]['value'];
