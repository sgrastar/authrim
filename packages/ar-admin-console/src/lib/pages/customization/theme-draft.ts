import { PREVIEW_SCREENS, type PreviewScreen } from './theme-sections';

/**
 * What the Themes page is editing, held in the page until it is wired to the Admin API. Empty
 * means "not set here": the template's own value applies.
 */
export type ThemeTemplate = 'standard' | 'split' | 'minimal';
export type ThemeFont = 'system' | 'serif' | 'rounded' | 'mono';
export type ThemeScale = 's' | 'm' | 'l';
export type LogoDisplay = 'both' | 'logo' | 'name';

/** The Split template: how it is framed and laid out (the legacy login-ui.split_* settings). */
export type SplitFrame = 'full' | 'card';
export type SplitSide = 'left' | 'right';
export type SplitWidth = 'narrow' | 'wide';
/** Where the background image goes: both sides, the brand side only, or the form side has its own. */
export type SplitBackground = 'shared' | 'brand' | 'panel';
export type BrandContent = 'logo_copy' | 'logo' | 'none';
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
	titles: Record<PreviewScreen, string>;
	tagline: string;
	footer: string;
}

export interface ThemeDraft {
	template: ThemeTemplate;
	background: string;
	accent: string;
	titleColor: string;
	textColor: string;
	/** The muted copy: tagline, brand panel text, footer. */
	copyColor: string;
	font: ThemeFont;
	scale: ThemeScale;
	header: boolean;
	footer: boolean;
	themeToggle: boolean;
	languageSelect: boolean;
	brandName: string;
	logoDisplay: LogoDisplay;
	panelTitle: string;
	panelText: string;
	splitFrame: SplitFrame;
	splitSide: SplitSide;
	splitWidth: SplitWidth;
	splitBackground: SplitBackground;
	brandContent: BrandContent;
	brandPosition: BrandPosition;
	brandAlign: BrandAlign;
	/** The form side's fill when the background is "brand only"; two colours make a gradient. */
	panelColor: string;
	panelGradient: string;
	/** The form side's own picture when the background is "panel image". */
	formImage: string | File | null;
	formImageOpacity: number;
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
	customCss: string;
}

/**
 * The choices of the Split panel, by group: each value has the message `th.<group>.<value>`.
 * One list for the screen and for the check that every label exists.
 */
export const SPLIT_CHOICES = {
	splitFrame: ['full', 'card'],
	splitSide: ['left', 'right'],
	splitWidth: ['narrow', 'wide'],
	splitBg: ['shared', 'brand', 'panel'],
	brandContent: ['logo_copy', 'logo', 'none'],
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

export const FONT_SCALES: Record<ThemeScale, number> = { s: 0.9, m: 1, l: 1.15 };

function emptyTexts(): ThemeTexts {
	const titles = Object.fromEntries(PREVIEW_SCREENS.map((screen) => [screen.value, '']));
	return { titles: titles as Record<PreviewScreen, string>, tagline: '', footer: '' };
}

export function newThemeDraft(): ThemeDraft {
	return {
		template: 'standard',
		background: '',
		accent: '',
		titleColor: '',
		textColor: '',
		copyColor: '',
		font: 'system',
		scale: 'm',
		header: true,
		footer: true,
		themeToggle: true,
		languageSelect: true,
		brandName: 'Example Inc.',
		logoDisplay: 'both',
		panelTitle: '',
		panelText: '',
		splitFrame: 'full',
		splitSide: 'left',
		splitWidth: 'narrow',
		splitBackground: 'shared',
		brandContent: 'logo_copy',
		brandPosition: 'center',
		brandAlign: 'left',
		panelColor: '',
		panelGradient: '',
		formImage: null,
		formImageOpacity: 70,
		language: 'en',
		texts: { en: emptyTexts(), ja: emptyTexts(), de: emptyTexts(), ar: emptyTexts() },
		logo: null,
		favicon: null,
		backgroundImage: null,
		backgroundOpacity: 100,
		panelImage: null,
		panelImageOpacity: 100,
		customCss: ''
	};
}
