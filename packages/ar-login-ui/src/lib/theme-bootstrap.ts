export type LoginUIThemeMode = 'light' | 'dark';
export type LoginUILightVariant = 'beige' | 'blue-gray' | 'green';
export type LoginUIDarkVariant = 'brown' | 'navy' | 'slate';

export const LOGIN_UI_THEME_HINT_COOKIE = 'authrim_theme_hint';
export const LOGIN_UI_LIGHT_VARIANT_HINT_COOKIE = 'authrim_light_variant_hint';
export const LOGIN_UI_DARK_VARIANT_HINT_COOKIE = 'authrim_dark_variant_hint';
export const LOGIN_UI_THEME_HINT_MAX_AGE_SECONDS = 60 * 60;

const LIGHT_VARIANT_BACKGROUNDS: Record<LoginUILightVariant, string> = {
	beige: '#eeeae3',
	'blue-gray': '#e8edf2',
	green: '#e8f2e8'
};

const DARK_VARIANT_BACKGROUNDS: Record<LoginUIDarkVariant, string> = {
	brown: '#0f0d0c',
	navy: '#0a0e14',
	slate: '#0f1419'
};

export function normalizeLoginUIThemeMode(value: unknown): LoginUIThemeMode | null {
	return value === 'light' || value === 'dark' ? value : null;
}

export function normalizeLoginUILightVariant(value: unknown): LoginUILightVariant | null {
	return value === 'beige' || value === 'blue-gray' || value === 'green' ? value : null;
}

export function normalizeLoginUIDarkVariant(value: unknown): LoginUIDarkVariant | null {
	return value === 'brown' || value === 'navy' || value === 'slate' ? value : null;
}

export function resolveLoginUIThemeBackground(
	mode: LoginUIThemeMode,
	variant: string | null | undefined,
	configuredBackground = ''
): string {
	if (configuredBackground) {
		return configuredBackground;
	}

	if (mode === 'dark') {
		const darkVariant = normalizeLoginUIDarkVariant(variant) ?? 'brown';
		return DARK_VARIANT_BACKGROUNDS[darkVariant];
	}

	const lightVariant = normalizeLoginUILightVariant(variant) ?? 'beige';
	return LIGHT_VARIANT_BACKGROUNDS[lightVariant];
}
