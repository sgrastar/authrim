/**
 * What the Themes page is editing, held in the page until it is wired to the Admin API. Empty
 * means "not set here": the template's own value applies.
 */
import type { PaletteId } from './theme-palettes';

export type ThemeTemplate = 'standard' | 'split' | 'minimal';
export type ThemeFont = 'system' | 'serif' | 'rounded' | 'mono';
/** How the screens are spaced: the form's padding and gaps (the real screens' `font_scale`). */
export type FontScale = 'compact' | 'comfortable' | 'spacious';
/** The colour mode: follow each visitor's device, or fix light or dark. */
export type ColourMode = 'auto' | 'light' | 'dark';
/**
 * Where the colour-mode and language choices sit (the real screens' `topbar_position`): in the
 * main area between the header and the footer, or (`form_bottom_*`, Split only) at the bottom of
 * the form side alone.
 */
export type TopbarPosition =
	| 'below_card'
	| 'in_card'
	| 'top_right'
	| 'bottom_left'
	| 'bottom_center'
	| 'bottom_right'
	| 'form_bottom_left'
	| 'form_bottom_center'
	| 'form_bottom_right'
	| 'hidden';
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
	accent: string;
	titleColor: string;
	textColor: string;
	/** The muted copy: tagline, brand panel text, footer. */
	copyColor: string;
	font: ThemeFont;
	fontScale: FontScale;
	mode: ColourMode;
	topbarPosition: TopbarPosition;
	header: boolean;
	footer: boolean;
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
	favicon: string | File | null;
	backgroundImage: string | File | null;
	/** 0–100: how much of the background image shows through (100 = as it is). */
	backgroundOpacity: number;
	/** The picture on the Split template's brand panel, apart from the page background. */
	panelImage: string | File | null;
	panelImageOpacity: number;
	/** The picture inside the form area (the box with the form), for Standard and Split. */
	cardImage: string | File | null;
	cardImageOpacity: number;
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
		accent: '',
		titleColor: '',
		textColor: '',
		copyColor: '',
		font: 'system',
		fontScale: 'comfortable',
		mode: 'auto',
		topbarPosition: 'below_card',
		header: true,
		footer: true,
		themeToggle: true,
		languageSelect: true,
		brandName: 'Authrim',
		headerName: 'Authrim',
		logoDisplay: 'both',
		brandLogoDisplay: 'both',
		panelTitle: 'Welcome to your account.',
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
		favicon: null,
		backgroundImage: null,
		backgroundOpacity: 100,
		panelImage: null,
		panelImageOpacity: 100,
		cardImage: null,
		cardImageOpacity: 100,
		customCss: ''
	};
}
