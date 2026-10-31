export type LoginUIThemeMode = 'light' | 'dark';
export type LoginUIThemeTemplate = 'classic' | 'meridian' | 'split-brand-panel' | 'fullbleed-glass';

export const LOGIN_UI_THEME_HINT_COOKIE = 'authrim_theme_hint';
export const LOGIN_UI_THEME_HINT_MAX_AGE_SECONDS = 60 * 60;

/** The theme template the Login UI uses when none is set (login-ui.theme_template). */
export const DEFAULT_LOGIN_UI_THEME_TEMPLATE: LoginUIThemeTemplate = 'meridian';

/**
 * The page background of each theme template in each mode, as app.css and themes.css paint it
 * (`--login-page-background-color`): painted before the styles load, so the first frame does
 * not flash another colour.
 */
const THEME_TEMPLATE_BACKGROUNDS: Record<LoginUIThemeTemplate, Record<LoginUIThemeMode, string>> = {
	classic: { light: '#eeeae3', dark: '#0f0d0c' },
	meridian: { light: '#eef1f6', dark: '#0b0e16' },
	'split-brand-panel': { light: '#eef1f6', dark: '#0b0e16' },
	'fullbleed-glass': { light: '#ecdfd3', dark: '#0d0908' }
};

export function normalizeLoginUIThemeMode(value: unknown): LoginUIThemeMode | null {
	return value === 'light' || value === 'dark' ? value : null;
}

export function normalizeLoginUIThemeTemplate(value: unknown): LoginUIThemeTemplate | null {
	return typeof value === 'string' && Object.hasOwn(THEME_TEMPLATE_BACKGROUNDS, value)
		? (value as LoginUIThemeTemplate)
		: null;
}

export function resolveLoginUIThemeBackground(
	mode: LoginUIThemeMode,
	template: string | null | undefined,
	configuredBackground = ''
): string {
	if (configuredBackground) {
		return configuredBackground;
	}
	const themeTemplate = normalizeLoginUIThemeTemplate(template) ?? DEFAULT_LOGIN_UI_THEME_TEMPLATE;
	return THEME_TEMPLATE_BACKGROUNDS[themeTemplate][mode];
}
