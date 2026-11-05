/**
 * Builds the `ui` block of the authentication-methods response that the Admin console produces,
 * so a story shows the Login UI as a tenant configuration would. Stories change only what they
 * demonstrate; everything else keeps the values below.
 */
import type { LoginUIConfig } from '#lib/api/authentication-methods.js';
import { LOGIN_UI_LOCALES } from '#lib/i18n/locales.js';
import { layoutFor, type PaletteId, type TemplateId } from '#lib/palettes.js';
import type { Scheme, ThemeTemplate } from './globals.svelte';

type PageTemplate = NonNullable<LoginUIConfig['pageTemplate']>;
type Appearance = NonNullable<LoginUIConfig['appearance']>;

export type LoginUIOverrides = {
	branding?: Partial<LoginUIConfig['branding']>;
	pageTemplate?: Partial<PageTemplate>;
	appearance?: Partial<Appearance>;
};

/**
 * A neutral 96x32 mark and a 96x54 gradient, as PNG data URIs: stories need no network, and the
 * Login UI refuses SVG images (an SVG can carry script), so a vector sample would never show.
 */
export const SAMPLE_LOGO_URL =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAApUlEQVR42u3azQ2AIAyA0e7lOo7gBF69uoFLOJnXOgEChRpSvqZXILyEhj/RRCz7U5UaNKTRJbyUdKQJySQeOpGMACoA8tAJYwQQQI1AfjoxjADqDVS7JFMDr9sxVAL0C5Bh2w0QQImpUqQBqgEy3xkBBNDnJM1tz+t2TYCGAcp2ARBAzSV23iINEBdmAAHEsw9A4wMpT89ZoF5MGivEfMia5PvLC0hm8CAwulvbAAAAAElFTkSuQmCC';

/** A soft gradient stands in for a tenant background photo. */
export const SAMPLE_BACKGROUND_URL =
	'data:image/png;base64,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';

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

/**
 * What a tenant saves is a template and a palette. `theme` (one of the four pre-palette names) is
 * for the galleries that pin a frame to one; it is what an older server would send, and the
 * Login UI reads it through the same fallback.
 */
export type LoginUIConfigInput =
	| { theme: ThemeTemplate; template?: undefined; palette?: undefined; scheme: Scheme }
	| { theme?: undefined; template: TemplateId; palette: PaletteId; scheme: Scheme };

/**
 * The pre-palette `themeTemplate` the server sends alongside a palette and template, for older
 * Login UI builds. `flat` did not exist then, so it is sent as the Meridian name of its template
 * (the same derivation as `deriveLegacyThemeTemplate` in ar-management).
 */
function serverLegacyTheme(palette: PaletteId, template: TemplateId): ThemeTemplate {
	if (palette === 'classic') return 'classic';
	if (palette === 'glass') return 'fullbleed-glass';
	return template === 'split' ? 'split-brand-panel' : 'meridian';
}

export function buildLoginUIConfig(
	input: LoginUIConfigInput,
	overrides: LoginUIOverrides = {}
): LoginUIConfig {
	const modern = input.theme === undefined;
	const themeName = modern ? serverLegacyTheme(input.palette, input.template) : input.theme;
	const pageTemplate: PageTemplate = {
		layout: modern ? layoutFor(input.template) : layoutForTheme(input.theme),
		...(modern ? { template: input.template, palette: input.palette } : {}),
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
		// The server does not derive the position from the template: a tenant that set none has
		// `below_card`. (The pre-palette path keeps the old Split brand panel preset's `bottom_right`.)
		topbarPosition: modern ? 'below_card' : topbarForTheme(input.theme),
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
	// A story that sets only the layout (the layouts gallery, a part shown on a centred page) says
	// nothing about the template, and the Login UI reads `template` before `layout`: leaving the
	// toolbar's template in would override the layout it asked for. Without it the Login UI derives
	// the template from the layout, as it does for a server that sends only the layout.
	if (
		modern &&
		overrides.pageTemplate?.layout !== undefined &&
		overrides.pageTemplate.template === undefined
	)
		delete pageTemplate.template;
	return {
		theme: input.scheme,
		themeTemplate: themeName,
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
