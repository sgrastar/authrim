import { accentTextColor, normalizeAccentColor } from '#lib/utils/accent-text.js';
import { browser } from '$app/env';
import type {
	LoginUIConfig,
	LoginUITextField,
	LoginUITextLocalizations
} from '#lib/api/authentication-methods.js';
import { syncLoginUIDocumentSurface } from '#lib/document-surface.js';
import {
	loginUIImageFilterCss,
	type LoginUIImageFilter
} from '@authrim/ar-lib-core/utils/login-ui-image-filters';
import {
	LOGIN_UI_THEME_COLOR_NAMES,
	type LoginUIThemeColorName
} from '@authrim/ar-lib-core/utils/login-ui-theme-colors';

/** Black or white, whichever reads better on a tenant's colour; its alpha, if any, left aside. */
const labelColorOn = (colour: string) =>
	accentTextColor(/^#[0-9a-f]{8}$/i.test(colour) ? colour.slice(0, 7) : colour);

/** A tenant's colour that text is laid on: kept only when a label colour can be chosen for it (hex
 *  or rgb(); a named colour is dropped, and the palette's own applies). */
function labelledColor(colour: string | undefined): string {
	const safe = sanitizeColor(colour);
	return safe && labelColorOn(safe) ? safe : '';
}

/** How each theme colour is taken from what the server sent: '' when it is not usable. */
const READ_COLOUR: Record<LoginUIThemeColorName, (value: unknown) => string> = {
	background: (value) => sanitizeColor(value as string) || '',
	form_area: (value) => sanitizeColor(value as string) || '',
	brand_panel_background: (value) => sanitizeColor(value as string) || '',
	// Applied opaque, from a colour every renderer resolves alike (see accent-text.ts).
	accent: (value) => normalizeAccentColor(sanitizeColor(value as string)) || '',
	link: (value) => sanitizeColor(value as string) || '',
	title: (value) => sanitizeColor(value as string) || '',
	text: (value) => sanitizeColor(value as string) || '',
	copy: (value) => sanitizeColor(value as string) || '',
	field: (value) => labelledColor(value as string),
	secondary_button: (value) => labelledColor(value as string),
	header_background: (value) => sanitizeColor(value as string) || '',
	header_text: (value) => sanitizeColor(value as string) || '',
	footer_background: (value) => sanitizeColor(value as string) || '',
	footer_text: (value) => sanitizeColor(value as string) || ''
};

type ThemeColours = Record<LoginUIThemeColorName, string>;

const noColours = (): ThemeColours =>
	Object.fromEntries(LOGIN_UI_THEME_COLOR_NAMES.map((name) => [name, ''])) as ThemeColours;

/**
 * The dark-mode colours the server sent, each taken as its light one is ('' for none). The server
 * checks a stored dark set strictly (the shared module); what it carries over from the light
 * colours of a theme fixed to dark mode follows their own rules, as here.
 */
function readDarkColours(value: unknown): ThemeColours {
	const colours = noColours();
	if (!value || typeof value !== 'object' || Array.isArray(value)) return colours;
	for (const name of LOGIN_UI_THEME_COLOR_NAMES) {
		const colour = (value as Record<string, unknown>)[name];
		if (typeof colour === 'string') colours[name] = READ_COLOUR[name](colour);
	}
	return colours;
}

type BarAlign = 'left' | 'center' | 'right';

function readBarAlign(value: unknown, fallback: BarAlign): BarAlign {
	return value === 'left' || value === 'center' || value === 'right' ? value : fallback;
}
import {
	cssUrl,
	isValidImageUrl,
	isValidLinkUrl,
	sanitizeColor
} from '#lib/utils/url-validation.js';
import {
	DEFAULT_PALETTE,
	DEFAULT_TEMPLATE,
	layoutFor,
	legacyThemeFor,
	readPalette,
	readTemplate,
	type LegacyThemeName,
	type PaletteId,
	type TemplateId
} from '#lib/palettes.js';

/** The value of `data-login-theme`: the pre-palette theme names, plus the palettes after them. */
type ThemeTemplate = LegacyThemeName;
type PageLayout = 'centered_card' | 'split_panel' | 'fullbleed_card';
type FontFamily = 'system' | 'rounded' | 'serif' | 'mono';
type FontScale = 'compact' | 'comfortable' | 'spacious';
type LogoDisplay = 'auto' | 'image' | 'text' | 'hidden';
type LanguageSwitcherPosition = 'below_card' | 'top_right' | 'hidden';
type TopbarPosition =
	| 'below_card'
	| 'in_card'
	| 'top_right'
	| 'bottom_left'
	| 'bottom_center'
	| 'bottom_right'
	| 'form_bottom_left'
	| 'form_bottom_center'
	| 'form_bottom_right'
	| 'header_left'
	| 'header_center'
	| 'header_right'
	| 'footer_left'
	| 'footer_center'
	| 'footer_right'
	| 'hidden';
type FormFrame = 'card' | 'full';
type BrandPanelLogoDisplay = 'inherit' | LogoDisplay;
type HeaderStyle = 'center' | 'bar';
type FooterStyle = 'simple' | 'bar';
type LogoLayout = 'stack' | 'row';
type SplitFrame = 'full' | 'card';
type SplitPanelSide = 'left' | 'right';
type SplitPanelWidth = 'narrow' | 'wide';
type SplitBackgroundMode = 'shared' | 'brand' | 'panel';
type BrandContentMode = 'logo_copy' | 'logo' | 'none';
type BrandPosition = 'top' | 'center' | 'bottom';
type BrandAlign = 'left' | 'center' | 'right';

interface FooterLink {
	label: string;
	url: string;
}

const DEFAULT_THEME_TEMPLATE: ThemeTemplate = 'meridian';
const DEFAULT_PAGE_LAYOUT: PageLayout = 'centered_card';

function readThemeTemplate(value: unknown): ThemeTemplate {
	// The old Full-bleed glass is Swiss Grid now: an older server's name is read as the new one.
	if (value === 'fullbleed-glass') return 'swiss-grid';
	return value === 'classic' ||
		value === 'split-brand-panel' ||
		value === 'swiss-grid' ||
		value === 'glass' ||
		value === 'clear-glass' ||
		value === 'flat' ||
		value === 'meridian'
		? value
		: DEFAULT_THEME_TEMPLATE;
}

/** The palette a pre-palette `themeTemplate` stands for (a server that sends no `palette`). */
function paletteOfThemeTemplate(value: ThemeTemplate): PaletteId {
	if (value === 'classic') return 'classic';
	if (value === 'swiss-grid') return 'swiss-grid';
	if (value === 'glass') return 'glass';
	if (value === 'clear-glass') return 'clear-glass';
	if (value === 'flat') return 'flat';
	return DEFAULT_PALETTE;
}

function templateOfLayout(value: PageLayout): TemplateId {
	return value === 'split_panel' ? 'split' : DEFAULT_TEMPLATE;
}

function readFormFrame(value: unknown): FormFrame {
	return value === 'full' || value === 'card' ? value : 'full';
}

function readBrandPanelLogoDisplay(value: unknown): BrandPanelLogoDisplay {
	return value === 'auto' ||
		value === 'image' ||
		value === 'text' ||
		value === 'hidden' ||
		value === 'inherit'
		? value
		: 'inherit';
}

function readPageLayout(value: unknown): PageLayout {
	return value === 'split_panel' || value === 'fullbleed_card' || value === 'centered_card'
		? value
		: DEFAULT_PAGE_LAYOUT;
}

function readFontFamily(value: unknown): FontFamily {
	return value === 'rounded' || value === 'serif' || value === 'mono' || value === 'system'
		? value
		: 'system';
}

function readFontScale(value: unknown): FontScale {
	return value === 'compact' || value === 'spacious' || value === 'comfortable'
		? value
		: 'comfortable';
}

function readLogoDisplay(value: unknown): LogoDisplay {
	return value === 'image' || value === 'text' || value === 'hidden' || value === 'auto'
		? value
		: 'auto';
}

function readLanguageSwitcherPosition(value: unknown): LanguageSwitcherPosition {
	return value === 'top_right' || value === 'hidden' || value === 'below_card'
		? value
		: 'below_card';
}

function readTopbarPosition(value: unknown, legacyValue: unknown): TopbarPosition {
	if (
		value === 'in_card' ||
		value === 'top_right' ||
		value === 'bottom_left' ||
		value === 'bottom_center' ||
		value === 'bottom_right' ||
		value === 'form_bottom_left' ||
		value === 'form_bottom_center' ||
		value === 'form_bottom_right' ||
		value === 'header_left' ||
		value === 'header_center' ||
		value === 'header_right' ||
		value === 'footer_left' ||
		value === 'footer_center' ||
		value === 'footer_right' ||
		value === 'hidden' ||
		value === 'below_card'
	) {
		return value;
	}
	const legacy = readLanguageSwitcherPosition(legacyValue);
	return legacy === 'top_right' || legacy === 'hidden' ? legacy : 'below_card';
}

function readHeaderStyle(value: unknown): HeaderStyle {
	return value === 'bar' || value === 'center' ? value : 'center';
}

function readFooterStyle(value: unknown): FooterStyle {
	return value === 'bar' || value === 'simple' ? value : 'simple';
}

function readLogoLayout(value: unknown): LogoLayout {
	return value === 'row' || value === 'stack' ? value : 'stack';
}

function readSplitFrame(value: unknown): SplitFrame {
	return value === 'card' || value === 'full' ? value : 'full';
}

function readSplitPanelSide(value: unknown): SplitPanelSide {
	return value === 'right' || value === 'left' ? value : 'left';
}

function readSplitPanelWidth(value: unknown): SplitPanelWidth {
	return value === 'narrow' || value === 'wide' ? value : 'narrow';
}

function readSplitBackgroundMode(value: unknown): SplitBackgroundMode {
	return value === 'brand' || value === 'panel' || value === 'shared' ? value : 'shared';
}

function readPercentage(value: unknown, fallback: number): number {
	const parsed =
		typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	return Number.isFinite(parsed) ? Math.min(100, Math.max(0, parsed)) : fallback;
}

function readBrandContentMode(value: unknown): BrandContentMode {
	return value === 'logo' || value === 'none' || value === 'logo_copy' ? value : 'logo_copy';
}

function readBrandPosition(value: unknown): BrandPosition {
	return value === 'top' || value === 'bottom' || value === 'center' ? value : 'center';
}

function readBrandAlign(value: unknown): BrandAlign {
	return value === 'center' || value === 'right' || value === 'left' ? value : 'left';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function readOptionalText(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

const LOGIN_UI_TEXT_FIELDS = new Set<LoginUITextField>([
	'tagline',
	'brandPanelTitle',
	'brandPanelText',
	'footerText',
	'loginTitle',
	'registrationTitle',
	'accountTitle'
]);

function readTextLocalizations(value: unknown): LoginUITextLocalizations {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([locale, localized]) => {
			if (!localized || typeof localized !== 'object' || Array.isArray(localized)) return [];
			const fields = Object.fromEntries(
				Object.entries(localized)
					.filter(
						(entry): entry is [LoginUITextField, string] =>
							LOGIN_UI_TEXT_FIELDS.has(entry[0] as LoginUITextField) && typeof entry[1] === 'string'
					)
					.map(([field, text]) => [field, text.trim()])
			);
			return Object.keys(fields).length > 0 ? [[locale, fields]] : [];
		})
	);
}

function safeFooterLinks(value: unknown): FooterLink[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((entry) => {
			if (!entry || typeof entry !== 'object') return null;
			const candidate = entry as Record<string, unknown>;
			const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
			const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
			return label && isValidLinkUrl(url) ? { label, url } : null;
		})
		.filter((entry): entry is FooterLink => entry !== null)
		.slice(0, 8);
}

function setOptionalStyleProperty(name: string, value: string | null) {
	if (!browser) return;
	const style = document.documentElement.style;
	if (value) {
		style.setProperty(name, value);
	} else {
		style.removeProperty(name);
	}
}

function setCustomCss(css: string | null) {
	if (!browser) return;
	const id = 'authrim-login-ui-custom-css';
	let element = document.getElementById(id) as HTMLStyleElement | null;
	if (!css) {
		element?.remove();
		return;
	}
	if (!element) {
		element = document.createElement('style');
		element.id = id;
		document.head.appendChild(element);
	}
	element.textContent = css;
}

export function createLoginUIPageStore() {
	let themeTemplate = $state<ThemeTemplate>(DEFAULT_THEME_TEMPLATE);
	let template = $state<TemplateId>(DEFAULT_TEMPLATE);
	let palette = $state<PaletteId>(DEFAULT_PALETTE);
	let formFrame = $state<FormFrame>('full');
	let formAreaColor = $state('');
	let brandPanelBackgroundColor = $state('');
	let fieldColor = $state('');
	let secondaryButtonColor = $state('');
	let headerName = $state('');
	let brandPanelLogoDisplay = $state<BrandPanelLogoDisplay>('inherit');
	let backgroundImageOpacity = $state(100);
	let backgroundImageGrayscale = $state(false);
	let backgroundImageFilter = $state('');
	let brandPanelImageUrl = $state<string | null>(null);
	let brandPanelImageOpacity = $state(100);
	let brandPanelImageGrayscale = $state(false);
	let layout = $state<PageLayout>(DEFAULT_PAGE_LAYOUT);
	let fontFamily = $state<FontFamily>('system');
	let fontScale = $state<FontScale>('comfortable');
	let backgroundColor = $state('');
	let accentColor = $state('');
	let titleColor = $state('');
	let textColor = $state('');
	let copyColor = $state('');
	let linkColor = $state('');
	let headerBackgroundColor = $state('');
	let headerTextColor = $state('');
	let footerBackgroundColor = $state('');
	let footerTextColor = $state('');
	/** The colours set for dark mode; '' where the palette's dark colour applies. */
	let darkColours = $state<ThemeColours>(noColours());
	/** The mode the page is shown in now (the theme store's): it picks the light or dark colours. */
	let colourMode = $state<'light' | 'dark'>('light');
	let headerAlign = $state<BarAlign>('left');
	let footerAlign = $state<BarAlign>('center');
	let backgroundImageUrl = $state<string | null>(null);
	let loginPanelBackgroundImageUrl = $state<string | null>(null);
	let loginPanelBackgroundColor = $state('');
	let loginPanelBackgroundGradientColor = $state('');
	let loginPanelBackgroundOpacity = $state(70);
	let loginPanelBackgroundGrayscale = $state(false);
	let headerEnabled = $state(true);
	let subtitleEnabled = $state(true);
	let footerEnabled = $state(true);
	let poweredByEnabled = $state(true);
	let authSwitchLinkEnabled = $state(true);
	let languageSwitcherPosition = $state<LanguageSwitcherPosition>('below_card');
	let topbarPosition = $state<TopbarPosition>('below_card');
	let themeToggleEnabled = $state(true);
	let themeFixed = $state(false);
	let languageSelectEnabled = $state(true);
	let headerStyle = $state<HeaderStyle>('center');
	let footerStyle = $state<FooterStyle>('simple');
	let logoLayout = $state<LogoLayout>('stack');
	let splitFrame = $state<SplitFrame>('full');
	let splitPanelSide = $state<SplitPanelSide>('left');
	let splitPanelWidth = $state<SplitPanelWidth>('narrow');
	let splitBackgroundMode = $state<SplitBackgroundMode>('shared');
	let brandContentMode = $state<BrandContentMode>('logo_copy');
	let brandPosition = $state<BrandPosition>('center');
	let brandAlign = $state<BrandAlign>('left');
	let logoDisplay = $state<LogoDisplay>('auto');
	let headerText = $state<string | null>(null);
	let textLocalizations = $state<LoginUITextLocalizations>({});
	let footerText = $state<string | null>(null);
	let footerLinks = $state<FooterLink[]>([]);
	let brandPanelTitle = $state<string | null>(null);
	let brandPanelText = $state<string | null>(null);
	let customCss = $state<string | null>(null);

	/** `inherit` follows the logo display of the form side. */
	// Grayscale counts only while there is a picture to turn gray (the glass palette's own light,
	// shown when there is no page picture, keeps its colour).
	const pageBackgroundGray = () => backgroundImageGrayscale && !!backgroundImageUrl;
	const loginPanelBackgroundGray = () =>
		loginPanelBackgroundGrayscale && !!loginPanelBackgroundImageUrl;
	const brandPanelImageGray = () => brandPanelImageGrayscale && !!brandPanelImageUrl;

	function effectiveBrandPanelLogoDisplay(): LogoDisplay {
		return brandPanelLogoDisplay === 'inherit' ? logoDisplay : brandPanelLogoDisplay;
	}

	/** A colour as it applies in the mode shown: the light one, or the dark one ('' = palette). */
	function current(name: LoginUIThemeColorName, light: string): string {
		return colourMode === 'dark' ? darkColours[name] : light;
	}

	/**
	 * Where the colour-mode and language choices go: in the header or footer bar only while that
	 * bar is shown (else under the card, or along the page bottom on the same side).
	 */
	function effectiveTopbarPosition(): TopbarPosition {
		if (topbarPosition.startsWith('header_') && !(headerEnabled && headerStyle === 'bar')) {
			return 'below_card';
		}
		if (topbarPosition.startsWith('footer_') && !(footerEnabled && footerStyle === 'bar')) {
			return topbarPosition.replace(/^footer_/, 'bottom_') as TopbarPosition;
		}
		return topbarPosition;
	}

	/** The colours on the document, for the mode shown. */
	function applyDocumentColours() {
		if (!browser) return;
		const html = document.documentElement;
		const formArea = current('form_area', formAreaColor);
		const brandPanelBackground = current('brand_panel_background', brandPanelBackgroundColor);
		const accent = current('accent', accentColor);
		html.setAttribute('data-has-form-area-color', formArea ? 'true' : 'false');
		html.setAttribute(
			'data-has-brand-panel-background-color',
			brandPanelBackground ? 'true' : 'false'
		);
		html.setAttribute('data-has-accent-color', accent ? 'true' : 'false');
		setOptionalStyleProperty(
			'--login-page-background-color',
			current('background', backgroundColor) || null
		);
		syncLoginUIDocumentSurface();
		setOptionalStyleProperty('--login-accent-color', accent || null);
		setOptionalStyleProperty('--login-accent-text', accentTextColor(accent));
		setOptionalStyleProperty('--login-title-color', current('title', titleColor) || null);
		setOptionalStyleProperty('--login-text-color', current('text', textColor) || null);
		setOptionalStyleProperty('--login-copy-color', current('copy', copyColor) || null);
		setOptionalStyleProperty('--login-link-color', current('link', linkColor) || null);
		setOptionalStyleProperty('--login-form-area-color', formArea || null);
		setOptionalStyleProperty('--login-brand-panel-background-color', brandPanelBackground || null);
	}

	function applyDocumentState(customCss: string | null) {
		if (!browser) return;
		const html = document.documentElement;
		html.setAttribute('data-login-theme', themeTemplate);
		html.setAttribute('data-login-template', template);
		html.setAttribute('data-login-palette', palette);
		html.setAttribute('data-form-frame', formFrame);
		html.setAttribute('data-page-layout', layout);
		html.setAttribute('data-font-family', fontFamily);
		html.setAttribute('data-font-scale', fontScale);
		html.setAttribute('data-language-switcher-position', languageSwitcherPosition);
		html.setAttribute('data-topbar-position', effectiveTopbarPosition());
		html.setAttribute('data-header-style', headerStyle);
		html.setAttribute('data-footer-style', footerStyle);
		html.setAttribute('data-logo-layout', logoLayout);
		html.setAttribute('data-split-frame', splitFrame);
		html.setAttribute('data-split-panel-side', splitPanelSide);
		html.setAttribute('data-split-panel-width', splitPanelWidth);
		html.setAttribute('data-split-background-mode', splitBackgroundMode);
		html.setAttribute('data-has-page-background-image', backgroundImageUrl ? 'true' : 'false');
		html.setAttribute(
			'data-has-login-panel-background-image',
			loginPanelBackgroundImageUrl ? 'true' : 'false'
		);
		html.setAttribute('data-brand-content-mode', brandContentMode);
		html.setAttribute('data-brand-position', brandPosition);
		html.setAttribute('data-brand-align', brandAlign);
		html.setAttribute('data-logo-display', logoDisplay);
		html.setAttribute('data-brand-panel-logo-display', effectiveBrandPanelLogoDisplay());
		html.setAttribute('data-has-brand-panel-image', brandPanelImageUrl ? 'true' : 'false');
		html.setAttribute('data-page-background-grayscale', String(pageBackgroundGray()));
		html.setAttribute('data-login-panel-background-grayscale', String(loginPanelBackgroundGray()));
		html.setAttribute('data-brand-panel-image-grayscale', String(brandPanelImageGray()));
		applyDocumentColours();
		setOptionalStyleProperty(
			'--login-page-background-layer',
			backgroundImageUrl && isValidImageUrl(backgroundImageUrl) ? cssUrl(backgroundImageUrl) : null
		);
		setOptionalStyleProperty(
			'--login-panel-background-layer',
			loginPanelBackgroundImageUrl && isValidImageUrl(loginPanelBackgroundImageUrl)
				? cssUrl(loginPanelBackgroundImageUrl)
				: null
		);
		setOptionalStyleProperty(
			'--login-panel-background-fill',
			loginPanelBackgroundColor
				? loginPanelBackgroundGradientColor
					? `linear-gradient(135deg, ${loginPanelBackgroundColor}, ${loginPanelBackgroundGradientColor})`
					: loginPanelBackgroundColor
				: null
		);
		setOptionalStyleProperty(
			'--login-panel-background-opacity',
			String(loginPanelBackgroundOpacity / 100)
		);
		setOptionalStyleProperty(
			'--login-page-background-opacity',
			String(backgroundImageOpacity / 100)
		);
		setOptionalStyleProperty(
			'--login-brand-panel-image-layer',
			brandPanelImageUrl && isValidImageUrl(brandPanelImageUrl) ? cssUrl(brandPanelImageUrl) : null
		);
		setOptionalStyleProperty(
			'--login-brand-panel-image-opacity',
			String(brandPanelImageOpacity / 100)
		);
		setCustomCss(customCss);
	}

	function setFromUIConfig(ui: LoginUIConfig | null | undefined) {
		const page = ui?.pageTemplate;
		const appearance = ui?.appearance;
		// A server that sends `palette` and `template` is read by them; an older one by the
		// pre-palette `themeTemplate` and `layout`, as before.
		const servedPalette = readPalette(page?.palette);
		const servedTemplate = readTemplate(page?.template);
		layout = servedTemplate ? layoutFor(servedTemplate) : readPageLayout(page?.layout);
		template = servedTemplate ?? templateOfLayout(layout);
		const legacyTheme = readThemeTemplate(ui?.themeTemplate);
		palette = servedPalette ?? paletteOfThemeTemplate(legacyTheme);
		themeTemplate = servedPalette ? legacyThemeFor(servedPalette, template) : legacyTheme;
		formFrame = readFormFrame(page?.formFrame);
		formAreaColor = READ_COLOUR.form_area(page?.formAreaColor);
		brandPanelBackgroundColor = READ_COLOUR.brand_panel_background(page?.brandPanelBackgroundColor);
		fieldColor = READ_COLOUR.field(page?.fieldColor);
		secondaryButtonColor = READ_COLOUR.secondary_button(page?.secondaryButtonColor);
		linkColor = READ_COLOUR.link(page?.linkColor);
		headerBackgroundColor = READ_COLOUR.header_background(page?.headerBackgroundColor);
		headerTextColor = READ_COLOUR.header_text(page?.headerTextColor);
		footerBackgroundColor = READ_COLOUR.footer_background(page?.footerBackgroundColor);
		footerTextColor = READ_COLOUR.footer_text(page?.footerTextColor);
		darkColours = readDarkColours(page?.darkColors);
		headerAlign = readBarAlign(page?.headerAlign, 'left');
		footerAlign = readBarAlign(page?.footerAlign, 'center');
		headerName = readOptionalText(ui?.branding?.headerName) ?? '';
		brandPanelLogoDisplay = readBrandPanelLogoDisplay(page?.brandPanelLogoDisplay);
		backgroundImageOpacity = readPercentage(appearance?.backgroundImageOpacity, 100);
		backgroundImageGrayscale = readBoolean(appearance?.backgroundImageGrayscale, false);
		// Built from the known filters only, each value checked against its range.
		backgroundImageFilter = Array.isArray(appearance?.backgroundImageFilters)
			? loginUIImageFilterCss(appearance.backgroundImageFilters as LoginUIImageFilter[])
			: '';
		brandPanelImageUrl =
			appearance?.brandPanelImageUrl && isValidImageUrl(appearance.brandPanelImageUrl)
				? appearance.brandPanelImageUrl
				: null;
		brandPanelImageOpacity = readPercentage(appearance?.brandPanelImageOpacity, 100);
		brandPanelImageGrayscale = readBoolean(appearance?.brandPanelImageGrayscale, false);
		fontFamily = readFontFamily(page?.fontFamily);
		fontScale = readFontScale(page?.fontScale);
		backgroundColor = READ_COLOUR.background(page?.backgroundColor);
		accentColor = READ_COLOUR.accent(page?.accentColor);
		titleColor = READ_COLOUR.title(page?.titleColor);
		textColor = READ_COLOUR.text(page?.textColor);
		copyColor = READ_COLOUR.copy(page?.copyColor);
		backgroundImageUrl =
			appearance?.backgroundImageUrl && isValidImageUrl(appearance.backgroundImageUrl)
				? appearance.backgroundImageUrl
				: null;
		loginPanelBackgroundImageUrl =
			appearance?.loginPanelBackgroundImageUrl &&
			isValidImageUrl(appearance.loginPanelBackgroundImageUrl)
				? appearance.loginPanelBackgroundImageUrl
				: null;
		loginPanelBackgroundColor = sanitizeColor(page?.loginPanelBackgroundColor) || '';
		loginPanelBackgroundGradientColor =
			sanitizeColor(page?.loginPanelBackgroundGradientColor) || '';
		loginPanelBackgroundOpacity = readPercentage(page?.loginPanelBackgroundOpacity, 70);
		loginPanelBackgroundGrayscale = readBoolean(page?.loginPanelBackgroundGrayscale, false);
		headerEnabled = readBoolean(page?.headerEnabled, true);
		subtitleEnabled = readBoolean(page?.subtitleEnabled, true);
		footerEnabled = readBoolean(page?.footerEnabled, true);
		poweredByEnabled = readBoolean(page?.poweredByEnabled, true);
		authSwitchLinkEnabled = readBoolean(page?.authSwitchLinkEnabled, true);
		languageSwitcherPosition = readLanguageSwitcherPosition(page?.languageSwitcherPosition);
		// "Form bottom" belongs to the split template's form side; where there is no such side it is
		// the page bottom, as before.
		const readPosition = readTopbarPosition(page?.topbarPosition, page?.languageSwitcherPosition);
		topbarPosition =
			layout === 'split_panel'
				? readPosition
				: (readPosition.replace(/^form_/, '') as TopbarPosition);
		themeToggleEnabled = readBoolean(page?.themeToggleEnabled, true);
		// Only a light or dark mode can be fixed (as the server serves it, and for an older one).
		const mode = ui?.theme?.trim().toLowerCase();
		themeFixed = readBoolean(ui?.themeFixed, false) && (mode === 'light' || mode === 'dark');
		languageSelectEnabled = readBoolean(page?.languageSelectEnabled, true);
		headerStyle = readHeaderStyle(page?.headerStyle);
		footerStyle = readFooterStyle(page?.footerStyle);
		logoLayout = readLogoLayout(page?.logoLayout);
		splitFrame = readSplitFrame(page?.splitFrame);
		splitPanelSide = readSplitPanelSide(page?.splitPanelSide);
		splitPanelWidth = readSplitPanelWidth(page?.splitPanelWidth);
		splitBackgroundMode = readSplitBackgroundMode(page?.splitBackgroundMode);
		brandContentMode = readBrandContentMode(page?.brandContentMode);
		brandPosition = readBrandPosition(page?.brandPosition);
		brandAlign = readBrandAlign(page?.brandAlign);
		logoDisplay = readLogoDisplay(page?.logoDisplay);
		headerText = readOptionalText(appearance?.headerText);
		textLocalizations = readTextLocalizations(appearance?.textLocalizations);
		footerText = readOptionalText(appearance?.footerText);
		footerLinks = safeFooterLinks(appearance?.footerLinks);
		brandPanelTitle = readOptionalText(page?.brandPanelTitle);
		brandPanelText = readOptionalText(page?.brandPanelText);
		customCss = readOptionalText(appearance?.customCss);
		applyDocumentState(customCss);
	}

	return {
		get themeTemplate() {
			return themeTemplate;
		},
		get template() {
			return template;
		},
		get palette() {
			return palette;
		},
		get formFrame() {
			return formFrame;
		},
		/**
		 * The colours below are the ones of the mode shown (see setColourMode): the light ones, or
		 * the dark ones. Each is empty while the palette's own applies.
		 */
		get colourMode() {
			return colourMode;
		},
		/** Shows the page's colours for the mode the page is in now (light or dark). */
		setColourMode(mode: 'light' | 'dark') {
			if (mode === colourMode) return;
			colourMode = mode;
			applyDocumentColours();
		},
		/** The form area colour (hex with optional alpha); empty while the palette's applies. */
		get formAreaColor() {
			return current('form_area', formAreaColor);
		},
		/** The optional Split brand area tint, including its alpha channel. */
		get brandPanelBackgroundColor() {
			return current('brand_panel_background', brandPanelBackgroundColor);
		},
		/** The text input colour (hex with optional alpha); empty while the palette's applies. */
		get fieldColor() {
			return current('field', fieldColor);
		},
		/** Black or white, whichever reads better on the input colour; null while none is set. */
		get fieldTextColor() {
			return labelColorOn(current('field', fieldColor));
		},
		/** The secondary button colour (hex with optional alpha); empty while the palette's applies. */
		get secondaryButtonColor() {
			return current('secondary_button', secondaryButtonColor);
		},
		/** Black or white, whichever reads better on the secondary button colour. */
		get secondaryButtonTextColor() {
			return labelColorOn(current('secondary_button', secondaryButtonColor));
		},
		get linkColor() {
			return current('link', linkColor);
		},
		get headerBackgroundColor() {
			return current('header_background', headerBackgroundColor);
		},
		get headerTextColor() {
			return current('header_text', headerTextColor);
		},
		get footerBackgroundColor() {
			return current('footer_background', footerBackgroundColor);
		},
		get footerTextColor() {
			return current('footer_text', footerTextColor);
		},
		/** Where the header bar places the brand. */
		get headerAlign() {
			return headerAlign;
		},
		/** Where the footer bar places its text and links. */
		get footerAlign() {
			return footerAlign;
		},
		/** The header is the bar along the top of the page (else a block over the form). */
		get headerBar() {
			return headerEnabled && headerStyle === 'bar';
		},
		/** The footer is the bar along the bottom of the page. */
		get footerBar() {
			return footerEnabled && footerStyle === 'bar';
		},
		/** The name shown in the page header; empty when none is set. */
		get headerName() {
			return headerName;
		},
		/** How the logo appears on the brand panel (`inherit` resolved to the form side's). */
		get brandPanelLogoDisplay() {
			return effectiveBrandPanelLogoDisplay();
		},
		/** `url("…")` for the page background image, or null (the same value the stylesheet reads). */
		get backgroundImageLayer() {
			return backgroundImageUrl ? cssUrl(backgroundImageUrl) : null;
		},
		get loginPanelBackgroundLayer() {
			return loginPanelBackgroundImageUrl ? cssUrl(loginPanelBackgroundImageUrl) : null;
		},
		get brandPanelImageLayer() {
			return brandPanelImageUrl ? cssUrl(brandPanelImageUrl) : null;
		},
		get backgroundImageOpacity() {
			return backgroundImageOpacity;
		},
		/** The page picture is shown in grayscale (only while there is one). */
		get backgroundImageGrayscale() {
			return pageBackgroundGray();
		},
		/** The CSS filter on the page picture ('' when there is none, or no picture). */
		get backgroundImageFilter() {
			return backgroundImageUrl ? backgroundImageFilter : '';
		},
		get brandPanelImageGrayscale() {
			return brandPanelImageGray();
		},
		get loginPanelBackgroundGrayscale() {
			return loginPanelBackgroundGray();
		},
		get brandPanelImageUrl() {
			return brandPanelImageUrl;
		},
		get brandPanelImageOpacity() {
			return brandPanelImageOpacity;
		},
		get layout() {
			return layout;
		},
		get fontFamily() {
			return fontFamily;
		},
		get fontScale() {
			return fontScale;
		},
		get backgroundColor() {
			return current('background', backgroundColor);
		},
		get accentColor() {
			return current('accent', accentColor);
		},
		/** The text colour that reads on the accent (null without an accent). */
		get accentTextColor() {
			return accentTextColor(current('accent', accentColor));
		},
		get titleColor() {
			return current('title', titleColor);
		},
		get textColor() {
			return current('text', textColor);
		},
		get copyColor() {
			return current('copy', copyColor);
		},
		get backgroundImageUrl() {
			return backgroundImageUrl;
		},
		get loginPanelBackgroundImageUrl() {
			return loginPanelBackgroundImageUrl;
		},
		get loginPanelBackgroundColor() {
			return loginPanelBackgroundColor;
		},
		get loginPanelBackgroundGradientColor() {
			return loginPanelBackgroundGradientColor;
		},
		get loginPanelBackgroundOpacity() {
			return loginPanelBackgroundOpacity;
		},
		/**
		 * The brand panel is an element of the split template. With no brand content it is gone,
		 * except under the floating card, where it is the stage behind the card (its picture and
		 * colour) and shows nothing of its own.
		 */
		get showBrandPanel() {
			return layout === 'split_panel' && (brandContentMode !== 'none' || formFrame === 'card');
		},
		get headerEnabled() {
			return headerEnabled;
		},
		get subtitleEnabled() {
			return subtitleEnabled;
		},
		get footerEnabled() {
			return footerEnabled;
		},
		get poweredByEnabled() {
			return poweredByEnabled;
		},
		get authSwitchLinkEnabled() {
			return authSwitchLinkEnabled;
		},
		get languageSwitcherPosition() {
			return languageSwitcherPosition;
		},
		get topbarPosition() {
			return effectiveTopbarPosition();
		},
		get showTopbar() {
			return (
				topbarPosition !== 'hidden' &&
				((themeToggleEnabled && !themeFixed) || languageSelectEnabled)
			);
		},
		/** The mode switch is offered unless the tenant disabled it or fixed the mode. */
		get themeToggleEnabled() {
			return themeToggleEnabled && !themeFixed;
		},
		get languageSelectEnabled() {
			return languageSelectEnabled;
		},
		get headerStyle() {
			return headerStyle;
		},
		get footerStyle() {
			return footerStyle;
		},
		get logoLayout() {
			return logoLayout;
		},
		get splitFrame() {
			return splitFrame;
		},
		get splitPanelSide() {
			return splitPanelSide;
		},
		get splitPanelWidth() {
			return splitPanelWidth;
		},
		get splitBackgroundMode() {
			return splitBackgroundMode;
		},
		get brandContentMode() {
			return brandContentMode;
		},
		get brandPosition() {
			return brandPosition;
		},
		get brandAlign() {
			return brandAlign;
		},
		get logoDisplay() {
			return logoDisplay;
		},
		get headerText() {
			return headerText;
		},
		getLocalizedText(locale: string, field: LoginUITextField) {
			const localized = textLocalizations[locale];
			if (localized && Object.prototype.hasOwnProperty.call(localized, field)) {
				return localized[field] ?? '';
			}
			if (field === 'tagline') return headerText;
			if (field === 'brandPanelTitle') return brandPanelTitle;
			if (field === 'brandPanelText') return brandPanelText;
			if (field === 'footerText') return footerText;
			return null;
		},
		get footerText() {
			return footerText;
		},
		get footerLinks() {
			return footerLinks;
		},
		get brandPanelTitle() {
			return brandPanelTitle;
		},
		get brandPanelText() {
			return brandPanelText;
		},
		get customCss() {
			return customCss;
		},
		setFromUIConfig
	};
}
