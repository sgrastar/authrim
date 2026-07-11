import { browser } from '$app/environment';
import type { LoginUIConfig } from '$lib/api/authentication-methods';
import { isValidImageUrl, isValidLinkUrl, sanitizeColor } from '$lib/utils/url-validation';

type ThemeTemplate = 'classic' | 'meridian' | 'split-brand-panel' | 'fullbleed-glass';
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
	| 'hidden';
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
	return value === 'classic' ||
		value === 'split-brand-panel' ||
		value === 'fullbleed-glass' ||
		value === 'meridian'
		? value
		: DEFAULT_THEME_TEMPLATE;
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
	let layout = $state<PageLayout>(DEFAULT_PAGE_LAYOUT);
	let fontFamily = $state<FontFamily>('system');
	let fontScale = $state<FontScale>('comfortable');
	let backgroundColor = $state('');
	let titleColor = $state('');
	let textColor = $state('');
	let copyColor = $state('');
	let backgroundImageUrl = $state<string | null>(null);
	let loginPanelBackgroundImageUrl = $state<string | null>(null);
	let loginPanelBackgroundColor = $state('');
	let loginPanelBackgroundGradientColor = $state('');
	let loginPanelBackgroundOpacity = $state(70);
	let headerEnabled = $state(true);
	let subtitleEnabled = $state(true);
	let footerEnabled = $state(true);
	let poweredByEnabled = $state(true);
	let authSwitchLinkEnabled = $state(true);
	let languageSwitcherPosition = $state<LanguageSwitcherPosition>('below_card');
	let topbarPosition = $state<TopbarPosition>('below_card');
	let themeToggleEnabled = $state(true);
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
	let footerText = $state<string | null>(null);
	let footerLinks = $state<FooterLink[]>([]);
	let brandPanelTitle = $state<string | null>(null);
	let brandPanelText = $state<string | null>(null);
	let customCss = $state<string | null>(null);

	function applyDocumentState(customCss: string | null) {
		if (!browser) return;
		const html = document.documentElement;
		html.setAttribute('data-login-theme', themeTemplate);
		html.setAttribute('data-page-layout', layout);
		html.setAttribute('data-font-family', fontFamily);
		html.setAttribute('data-font-scale', fontScale);
		html.setAttribute('data-language-switcher-position', languageSwitcherPosition);
		html.setAttribute('data-topbar-position', topbarPosition);
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

		setOptionalStyleProperty(
			'--login-page-background-color',
			sanitizeColor(backgroundColor) || null
		);
		setOptionalStyleProperty('--login-title-color', sanitizeColor(titleColor) || null);
		setOptionalStyleProperty('--login-text-color', sanitizeColor(textColor) || null);
		setOptionalStyleProperty('--login-copy-color', sanitizeColor(copyColor) || null);
		setOptionalStyleProperty(
			'--login-page-background-layer',
			backgroundImageUrl && isValidImageUrl(backgroundImageUrl)
				? `url("${backgroundImageUrl}")`
				: null
		);
		setOptionalStyleProperty(
			'--login-panel-background-layer',
			loginPanelBackgroundImageUrl && isValidImageUrl(loginPanelBackgroundImageUrl)
				? `url("${loginPanelBackgroundImageUrl}")`
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
		setCustomCss(customCss);
	}

	function setFromUIConfig(ui: LoginUIConfig | null | undefined) {
		const page = ui?.pageTemplate;
		const appearance = ui?.appearance;
		themeTemplate = readThemeTemplate(ui?.themeTemplate);
		layout = readPageLayout(page?.layout);
		fontFamily = readFontFamily(page?.fontFamily);
		fontScale = readFontScale(page?.fontScale);
		backgroundColor = sanitizeColor(page?.backgroundColor) || '';
		titleColor = sanitizeColor(page?.titleColor) || '';
		textColor = sanitizeColor(page?.textColor) || '';
		copyColor = sanitizeColor(page?.copyColor) || '';
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
		headerEnabled = readBoolean(page?.headerEnabled, true);
		subtitleEnabled = readBoolean(page?.subtitleEnabled, true);
		footerEnabled = readBoolean(page?.footerEnabled, true);
		poweredByEnabled = readBoolean(page?.poweredByEnabled, true);
		authSwitchLinkEnabled = readBoolean(page?.authSwitchLinkEnabled, true);
		languageSwitcherPosition = readLanguageSwitcherPosition(page?.languageSwitcherPosition);
		topbarPosition = readTopbarPosition(page?.topbarPosition, page?.languageSwitcherPosition);
		themeToggleEnabled = readBoolean(page?.themeToggleEnabled, true);
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
			return backgroundColor;
		},
		get titleColor() {
			return titleColor;
		},
		get textColor() {
			return textColor;
		},
		get copyColor() {
			return copyColor;
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
		get showBrandPanel() {
			return layout === 'split_panel' && brandContentMode !== 'none';
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
			return topbarPosition;
		},
		get showTopbar() {
			return topbarPosition !== 'hidden' && (themeToggleEnabled || languageSelectEnabled);
		},
		get themeToggleEnabled() {
			return themeToggleEnabled;
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
