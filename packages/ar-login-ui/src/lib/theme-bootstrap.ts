import { PALETTE_BACKGROUNDS, type PaletteId } from './palettes.js';

export type LoginUIThemeMode = 'light' | 'dark';
/** A pre-palette theme name, or a palette id (`glass` and `flat` have no pre-palette name). */
export type LoginUIThemeTemplate =
	| 'classic'
	| 'meridian'
	| 'split-brand-panel'
	| 'fullbleed-glass'
	| PaletteId;

export const LOGIN_UI_THEME_HINT_COOKIE = 'authrim_theme_hint';
/** Where the visitor's own light / dark choice is kept (localStorage). */
export const LOGIN_UI_THEME_STORAGE_KEY = 'authrim-theme';
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
	'fullbleed-glass': { light: '#ecdfd3', dark: '#0d0908' },
	// The palette ids not already named above; the palette table is the single source.
	glass: PALETTE_BACKGROUNDS.glass,
	flat: PALETTE_BACKGROUNDS.flat
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

/**
 * The script that settles the mode before the first paint, for a tenant whose theme is `auto`
 * when the visitor has no hint cookie: the server cannot know the device's colour scheme, so it
 * renders light and this script takes the visitor's saved choice, else the device's, and sets what
 * the stylesheet reads (`data-theme` on the root and on the theme boundary) and the first-frame
 * colours. It runs the same resolution as the theme store, so the hydrated page agrees with it.
 *
 * It sits in the head, so it runs before any of the body is parsed. The body and the boundary do
 * not exist yet then: a MutationObserver patches each the moment the parser inserts it (observer
 * callbacks run before the next rendering opportunity), and stops once both are done.
 * `darkBackground` is a sanitised colour or a palette constant.
 */
export function buildFirstPaintThemeScript(darkBackground: string): string {
	// `<` is escaped so the colour can never end the script element.
	const bg = JSON.stringify(darkBackground).replaceAll('<', '\\u003c');
	const key = JSON.stringify(LOGIN_UI_THEME_STORAGE_KEY);
	return (
		`<script>(function(){var m=null;try{var s=localStorage.getItem(${key});` +
		`if(s==='light'||s==='dark')m=s}catch(e){}` +
		`if(!m)m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';` +
		`var k=m==='dark',d=document.documentElement;d.style.colorScheme=m;d.setAttribute('data-theme',m);` +
		`if(k){d.style.backgroundColor=${bg};` +
		`var t=document.querySelector('meta[name=theme-color]');if(t)t.setAttribute('content',${bg})}` +
		`var x=false;function f(){if(x)return true;var b=document.body,e=document.querySelector('.login-ui-theme-boundary');` +
		`if(b){b.style.colorScheme=m;if(k)b.style.backgroundColor=${bg}}` +
		`if(e)e.setAttribute('data-theme',m);return x=!!(b&&e)}` +
		`if(!f()){var o=new MutationObserver(function(){if(f()){o.disconnect();document.removeEventListener('DOMContentLoaded',g)}});` +
		`function g(){f();x=true;o.disconnect()}` +
		`o.observe(d,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',g)}})()</script>`
	);
}
