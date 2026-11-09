/**
 * What the Themes page is editing, held in the page until it is wired to the Admin API. Empty
 * means "not set here": the template's own value applies.
 */
import type { PaletteId } from './theme-palettes';
import type { LoginUIImageFilter } from '@authrim/ar-lib-core/utils/login-ui-image-filters';
import type { LoginUIThemeColors } from '@authrim/ar-lib-core/utils/login-ui-theme-colors';

export type ThemeTemplate = 'standard' | 'split' | 'minimal';
export type ThemeFont = 'system' | 'serif' | 'rounded' | 'mono';
/** How the screens are spaced: the form's padding and gaps (the real screens' `font_scale`). */
export type FontScale = 'compact' | 'comfortable' | 'spacious';
/** The colour mode: follow each visitor's device, or fix light or dark. */
export type ColourMode = 'auto' | 'light' | 'dark';
/**
 * Where the colour-mode and language choices sit (the real screens' `topbar_position`): in the
 * main area between the header and the footer, in the header or footer bar (`header_*`,
 * `footer_*`), or (`form_bottom_*`, Split only) at the bottom of the form side alone.
 */
export type TopbarPosition =
	| 'below_card'
	| 'in_card'
	| 'top_right'
	| 'bottom_left'
	| 'bottom_center'
	| 'bottom_right'
	| 'header_left'
	| 'header_center'
	| 'header_right'
	| 'footer_left'
	| 'footer_center'
	| 'footer_right'
	| 'form_bottom_left'
	| 'form_bottom_center'
	| 'form_bottom_right'
	| 'hidden';
/** Where a bar (the header or the footer) places what it shows. */
export type BarAlign = 'left' | 'center' | 'right';
export const BAR_ALIGNS: readonly BarAlign[] = ['left', 'center', 'right'];
export type LogoDisplay = 'both' | 'logo' | 'name';

/** The Split template: how it is framed and laid out (the legacy login-ui.split_* settings). */
export type SplitFrame = 'full' | 'card';
export type SplitSide = 'left' | 'right';
/** The form area in Split: filling its side, or a floating card on it. */
export type FormFrame = 'full' | 'card';
export type SplitWidth = 'narrow' | 'wide';
/** What the Split template's brand panel shows of the brand; "none" shows nothing of it. */
export type BrandPanelDisplay = LogoDisplay | 'none';
export type BrandPosition = 'top' | 'center' | 'bottom';
export type BrandAlign = 'left' | 'center' | 'right';

/** The languages the sign-in screens are offered in; each has its own texts. */
export const TEXT_LANGUAGES = [
	{ value: 'en', label: 'English' },
	{ value: 'ja', label: '日本語' },
	{ value: 'de', label: 'Deutsch' },
	{ value: 'ar', label: 'العربية' }
] as const;

export type TextLanguage = (typeof TEXT_LANGUAGES)[number]['value'];

export interface ThemeTexts {
	tagline: string;
	footer: string;
}

export interface ThemeDraft {
	template: ThemeTemplate;
	/** The colours and shape the screens start from; set colours below replace its own. */
	palette: PaletteId;
	background: string;
	/** The form area: the box that holds the sign-in form. */
	cardColor: string;
	/** The tint over the Split brand panel, including its image. */
	brandPanelBackground: string;
	accent: string;
	titleColor: string;
	textColor: string;
	/** The muted copy: tagline, brand panel text, footer. */
	copyColor: string;
	/** The text input fields' background. */
	fieldColor: string;
	/** The secondary buttons' background (the main button takes the accent). */
	secondaryButtonColor: string;
	/** The light/dark toggle and language selector backgrounds. Their ink is automatic. */
	themeToggleBackground: string;
	languageSelectBackground: string;
	/** The text links (the sign-in / sign-up switch); empty follows the accent. */
	linkColor: string;
	headerBackground: string;
	headerText: string;
	footerBackground: string;
	footerText: string;
	/** The colours of dark mode, by name; one not set follows the palette's dark colour. */
	darkColours: LoginUIThemeColors;
	font: ThemeFont;
	fontScale: FontScale;
	mode: ColourMode;
	topbarPosition: TopbarPosition;
	header: boolean;
	footer: boolean;
	headerAlign: BarAlign;
	footerAlign: BarAlign;
	themeToggle: boolean;
	languageSelect: boolean;
	/** The brand's name, in small capitals over the brand panel's title (Split only). */
	brandName: string;
	/** The name the header shows. */
	headerName: string;
	/** What the header shows of the brand: the logo, the name or both. */
	logoDisplay: LogoDisplay;
	/** The same choice for the Split template's brand panel, apart from the header's. */
	brandLogoDisplay: BrandPanelDisplay;
	panelTitle: string;
	panelText: string;
	splitFrame: SplitFrame;
	splitSide: SplitSide;
	formFrame: FormFrame;
	splitWidth: SplitWidth;
	brandPosition: BrandPosition;
	brandAlign: BrandAlign;
	language: TextLanguage;
	texts: Record<TextLanguage, ThemeTexts>;
	/** A stored image's URL, a newly chosen file, or none. */
	logo: string | File | null;
	/** Dark images are independent: null means show no image in that mode. */
	darkImages: {
		logo: string | File | null;
		backgroundImage: string | File | null;
		cardImage: string | File | null;
	};
	favicon: string | File | null;
	backgroundImage: string | File | null;
	/** 0–100: how much of the background image shows through (100 = as it is). */
	backgroundOpacity: number;
	/** Filters on the background image, in the order they apply (each at most once). */
	backgroundFilters: LoginUIImageFilter[];
	/** The picture on the Split template's brand panel, apart from the page background. */
	panelImage: string | File | null;
	panelImageOpacity: number;
	panelImageGrayscale: boolean;
	/** The picture inside the form area (the box with the form), for Standard and Split. */
	cardImage: string | File | null;
	cardImageOpacity: number;
	cardImageGrayscale: boolean;
	customCss: string;
}

/**
 * The choices of the Split panel, by group: each value has the message `th.<group>.<value>`.
 * One list for the screen and for the check that every label exists.
 */
export const SPLIT_CHOICES = {
	splitFrame: ['full', 'card'],
	splitSide: ['left', 'right'],
	formFrame: ['full', 'card'],
	splitWidth: ['narrow', 'wide'],
	brandPosition: ['top', 'center', 'bottom'],
	brandAlign: ['left', 'center', 'right']
} as const;

/** Font stacks of the typefaces on offer; system fonts only, so nothing is downloaded. */
export const FONT_STACKS: Record<ThemeFont, string> = {
	system: 'system-ui, sans-serif',
	serif: "Georgia, 'Times New Roman', serif",
	rounded: "'Hiragino Maru Gothic ProN', 'Arial Rounded MT Bold', system-ui, sans-serif",
	mono: "ui-monospace, 'SF Mono', Menlo, monospace"
};

/**
 * The form's padding and gaps against the comfortable ones, in the ratios the real screens use
 * (card padding 18 / 20 / 24 px).
 */
export const DENSITIES: Record<FontScale, number> = { compact: 0.9, comfortable: 1, spacious: 1.2 };

export const TOPBAR_POSITIONS: readonly TopbarPosition[] = [
	'below_card',
	'in_card',
	'top_right',
	'bottom_left',
	'bottom_center',
	'bottom_right',
	'header_left',
	'header_center',
	'header_right',
	'footer_left',
	'footer_center',
	'footer_right',
	'form_bottom_left',
	'form_bottom_center',
	'form_bottom_right',
	'hidden'
];

/** The footer text every language starts with: a link to Authrim, which opens in a new window. */
export const DEFAULT_FOOTER = 'Powered by <a href="https://authrim.com/">Authrim</a>';

function emptyTexts(): ThemeTexts {
	return { tagline: '', footer: DEFAULT_FOOTER };
}

export function newThemeDraft(): ThemeDraft {
	return {
		template: 'standard',
		palette: 'meridian',
		background: '',
		cardColor: '',
		brandPanelBackground: '',
		accent: '',
		titleColor: '',
		textColor: '',
		copyColor: '',
		fieldColor: '',
		secondaryButtonColor: '',
		themeToggleBackground: '',
		languageSelectBackground: '',
		linkColor: '',
		headerBackground: '',
		headerText: '',
		footerBackground: '',
		footerText: '',
		darkColours: {},
		font: 'system',
		fontScale: 'comfortable',
		mode: 'auto',
		topbarPosition: 'below_card',
		header: true,
		footer: true,
		headerAlign: 'left',
		footerAlign: 'center',
		themeToggle: true,
		languageSelect: true,
		brandName: 'Authrim',
		headerName: 'Authrim',
		logoDisplay: 'both',
		brandLogoDisplay: 'both',
		panelTitle: 'Ready when you are.',
		panelText: '',
		splitFrame: 'full',
		splitSide: 'left',
		formFrame: 'full',
		splitWidth: 'narrow',
		brandPosition: 'center',
		brandAlign: 'left',
		language: 'en',
		texts: { en: emptyTexts(), ja: emptyTexts(), de: emptyTexts(), ar: emptyTexts() },
		logo: null,
		darkImages: { logo: null, backgroundImage: null, cardImage: null },
		favicon: null,
		backgroundImage: null,
		backgroundOpacity: 100,
		backgroundFilters: [],
		panelImage: null,
		panelImageOpacity: 100,
		panelImageGrayscale: false,
		cardImage: null,
		cardImageOpacity: 100,
		cardImageGrayscale: false,
		customCss: ''
	};
}
