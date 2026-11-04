import { PREVIEW_SCREENS, type PreviewScreen } from './theme-sections';

/**
 * What the Themes page is editing, held in the page until it is wired to the Admin API. Empty
 * means "not set here": the template's own value applies.
 */
export type ThemeTemplate = 'standard' | 'split' | 'minimal';
export type ThemeFont = 'system' | 'serif' | 'rounded' | 'mono';
export type ThemeScale = 's' | 'm' | 'l';
export type LogoDisplay = 'both' | 'logo' | 'name';

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
