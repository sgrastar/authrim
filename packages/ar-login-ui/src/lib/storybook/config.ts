/**
 * Builds the `ui` block of the authentication-methods response that the Admin console produces,
 * so a story shows the Login UI as a tenant configuration would. Stories change only what they
 * demonstrate; everything else keeps the values below.
 */
import type { LoginUIConfig } from '$lib/api/authentication-methods';
import { LOGIN_UI_LOCALES } from '$lib/i18n/locales';
import type { Scheme, ThemeTemplate } from './globals.svelte';

type PageTemplate = NonNullable<LoginUIConfig['pageTemplate']>;
type Appearance = NonNullable<LoginUIConfig['appearance']>;

export type LoginUIOverrides = {
	branding?: Partial<LoginUIConfig['branding']>;
	pageTemplate?: Partial<PageTemplate>;
	appearance?: Partial<Appearance>;
};

/** A neutral 160x48 wordmark; a data URI keeps stories free of network access. */
export const SAMPLE_LOGO_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="160" height="48" viewBox="0 0 160 48"><rect width="48" height="48" rx="12" fill="#3b82f6"/><path d="M14 34 24 12l10 22h-6l-4-9-4 9z" fill="#fff"/><text x="58" y="31" font-family="sans-serif" font-size="20" font-weight="700" fill="#64748b">Acme ID</text></svg>'
)}`;

/** A soft gradient stands in for a tenant background photo. */
export const SAMPLE_BACKGROUND_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e3a8a"/><stop offset="0.55" stop-color="#6d28d9"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/></svg>'
)}`;

/** The top bar position the Admin console's theme presets pick (split-brand-panel moves it clear of the panel). */
export function topbarForTheme(theme: ThemeTemplate): NonNullable<PageTemplate['topbarPosition']> {
	return theme === 'split-brand-panel' ? 'bottom_right' : 'below_card';
}

/** The page layout each theme template ships with in the Admin console. */
export function layoutForTheme(theme: ThemeTemplate): PageTemplate['layout'] {
	if (theme === 'split-brand-panel') return 'split_panel';
	if (theme === 'fullbleed-glass') return 'fullbleed_card';
	return 'centered_card';
}

export function buildLoginUIConfig(
	input: { theme: ThemeTemplate; scheme: Scheme },
	overrides: LoginUIOverrides = {}
): LoginUIConfig {
	const pageTemplate: PageTemplate = {
		layout: layoutForTheme(input.theme),
		fontFamily: 'system',
		fontScale: 'comfortable',
		backgroundColor: '',
		logoDisplay: 'auto',
		logoLayout: 'stack',
		headerEnabled: true,
		subtitleEnabled: true,
		footerEnabled: true,
		poweredByEnabled: true,
		authSwitchLinkEnabled: true,
		topbarPosition: topbarForTheme(input.theme),
		themeToggleEnabled: true,
		languageSelectEnabled: true,
		languageSwitcherPosition: 'below_card',
		headerStyle: 'center',
		footerStyle: 'simple',
		splitFrame: 'full',
		splitPanelSide: 'left',
		splitPanelWidth: 'narrow',
		splitBackgroundMode: 'shared',
		brandContentMode: 'logo_copy',
		brandPosition: 'center',
		brandAlign: 'left',
		brandPanelTitle: 'Acme ID',
		brandPanelText: 'One account for every Acme service.',
		...overrides.pageTemplate
	};
	return {
		theme: input.scheme,
		themeTemplate: input.theme,
		branding: {
			logoUrl: SAMPLE_LOGO_URL,
			faviconUrl: null,
			brandName: 'Acme ID',
			...overrides.branding
		},
		pageTemplate,
		appearance: {
			backgroundImageUrl: null,
			loginPanelBackgroundImageUrl: null,
			customCss: null,
			headerText: null,
			footerText: null,
			footerLinks: [],
			customBlocks: [],
			...overrides.appearance
		},
		supportedLocales: [...LOGIN_UI_LOCALES],
		defaultLocale: 'ja',
		primaryLocales: ['ja', 'en'],
		showEnglishLanguageNames: false
	};
}
