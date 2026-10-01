/**
 * Theme axes. Kept free of Svelte so app.html's boot script test and Storybook can share it.
 * The boot script in src/app.html mirrors STORAGE_KEYS and the attribute names below; the
 * test in theme.test.ts fails if they drift apart.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_LOOKS = ['standard', 'swiss-grid', 'frosted'] as const;
export type ThemeLook = (typeof THEME_LOOKS)[number];

export type ColorScheme = 'light' | 'dark';

export const STORAGE_KEYS = {
	mode: 'authrim-console-mode',
	look: 'authrim-console-theme'
} as const;

export const DEFAULT_MODE: ThemeMode = 'system';
export const DEFAULT_LOOK: ThemeLook = 'standard';

export function isThemeMode(value: unknown): value is ThemeMode {
	return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

export function isThemeLook(value: unknown): value is ThemeLook {
	return typeof value === 'string' && (THEME_LOOKS as readonly string[]).includes(value);
}

/** Writes the theme to <html>. */
export function applyThemeAttributes(
	root: HTMLElement,
	mode: ThemeMode,
	scheme: ColorScheme,
	look: string
): void {
	root.dataset.adminTheme = look;
	root.dataset.scheme = scheme;
	if (mode === 'system') delete root.dataset.theme;
	else root.dataset.theme = mode;
}
