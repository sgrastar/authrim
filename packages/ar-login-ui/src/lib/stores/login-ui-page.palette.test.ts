// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginUIConfig } from '#lib/api/authentication-methods.js';
import { createBrandingStore } from './branding.svelte';
import { createLoginUIPageStore } from './login-ui-page.svelte';

vi.mock('$app/env', () => ({ browser: true }));

type PageTemplate = NonNullable<LoginUIConfig['pageTemplate']>;

function config(page: Partial<PageTemplate>, extra: Partial<LoginUIConfig> = {}): LoginUIConfig {
	return {
		theme: 'auto',
		branding: { brandName: 'Example', logoUrl: null },
		pageTemplate: {
			layout: 'centered_card',
			fontFamily: 'system',
			fontScale: 'comfortable',
			backgroundColor: '',
			logoDisplay: 'auto',
			headerEnabled: true,
			subtitleEnabled: true,
			footerEnabled: true,
			poweredByEnabled: true,
			authSwitchLinkEnabled: true,
			languageSwitcherPosition: 'below_card',
			brandPanelTitle: null,
			brandPanelText: null,
			...page
		},
		supportedLocales: ['en'],
		defaultLocale: 'en',
		...extra
	};
}

const html = () => document.documentElement;

describe('loginUIPageStore templates and palettes', () => {
	beforeEach(() => {
		html().removeAttribute('style');
		for (const name of [...html().getAttributeNames()].filter((n) => n.startsWith('data-'))) {
			html().removeAttribute(name);
		}
		html().setAttribute('data-theme', 'light');
		document.getElementById('authrim-login-ui-custom-css')?.remove();
	});

	it('reads the template and palette a current server sends', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ template: 'split', palette: 'clean', layout: 'split_panel' }));

		expect(store.template).toBe('split');
		expect(store.palette).toBe('clean');
		expect(store.layout).toBe('split_panel');
		expect(html().getAttribute('data-login-template')).toBe('split');
		expect(html().getAttribute('data-login-palette')).toBe('clean');
		expect(html().getAttribute('data-login-theme')).toBe('clean');
		expect(html().getAttribute('data-page-layout')).toBe('split_panel');
	});

	it.each([
		['clean', 'standard', 'clean'],
		['clean', 'split', 'clean'],
		['clean', 'minimal', 'clean'],
		['classic', 'split', 'classic'],
		['swiss-grid', 'standard', 'swiss-grid'],
		['swiss-grid', 'split', 'swiss-grid'],
		['glass', 'standard', 'glass'],
		['glass', 'split', 'glass'],
		['clear-glass', 'standard', 'clear-glass']
	] as const)(
		'paints the %s palette on the %s template with the %s rules',
		(palette, template, theme) => {
			const store = createLoginUIPageStore();
			store.setFromUIConfig(config({ palette, template }));

			expect(html().getAttribute('data-login-theme')).toBe(theme);
			expect(html().getAttribute('data-page-layout')).toBe(
				template === 'split' ? 'split_panel' : 'centered_card'
			);
		}
	);

	it('gives the minimal template the centred layout', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ template: 'minimal', palette: 'clean' }));

		expect(store.layout).toBe('centered_card');
		expect(html().getAttribute('data-login-template')).toBe('minimal');
	});

	it('reads an older server by its themeTemplate and layout', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ layout: 'split_panel' }, { themeTemplate: 'fullbleed-glass' }));

		// The old Full-bleed glass is Swiss Grid now: an older server's name is read as the new one.
		expect(store.palette).toBe('swiss-grid');
		expect(store.template).toBe('split');
		expect(store.themeTemplate).toBe('swiss-grid');
		expect(html().getAttribute('data-login-theme')).toBe('swiss-grid');
		expect(html().getAttribute('data-page-layout')).toBe('split_panel');
	});

	it('falls back to the defaults for ids it does not know', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config({
				palette: 'neon' as PageTemplate['palette'],
				template: 'fullbleed' as PageTemplate['template']
			})
		);

		expect(store.palette).toBe('clean');
		expect(store.template).toBe('standard');
		expect(html().getAttribute('data-login-theme')).toBe('clean');
	});

	it('applies the form frame and the form area colour', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({}));
		expect(store.formFrame).toBe('full');

		store.setFromUIConfig(config({ formFrame: 'card', formAreaColor: '#ffffff80' }));

		expect(store.formFrame).toBe('card');
		expect(html().getAttribute('data-form-frame')).toBe('card');
		expect(html().style.getPropertyValue('--login-form-area-color')).toBe('#ffffff80');
	});

	it('drops a form area colour that is not a colour, and an unknown frame', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config({
				formFrame: 'floating' as PageTemplate['formFrame'],
				formAreaColor: 'url(javascript:alert(1))'
			})
		);

		expect(store.formFrame).toBe('full');
		expect(html().style.getPropertyValue('--login-form-area-color')).toBe('');
	});

	it('applies the Split brand area tint per colour mode and rejects unsafe values', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config({
				template: 'split',
				brandPanelBackgroundColor: '#090d1e61',
				darkColors: { brand_panel_background: '#01020380' }
			})
		);
		expect(html().style.getPropertyValue('--login-brand-panel-background-color')).toBe('#090d1e61');
		expect(html().getAttribute('data-has-brand-panel-background-color')).toBe('true');
		store.setColourMode('dark');
		expect(html().style.getPropertyValue('--login-brand-panel-background-color')).toBe('#01020380');
		store.setFromUIConfig(config({ brandPanelBackgroundColor: 'url(javascript:alert(1))' }));
		expect(html().style.getPropertyValue('--login-brand-panel-background-color')).toBe('');
		expect(html().getAttribute('data-has-brand-panel-background-color')).toBe('false');
	});

	it('uses readable ink on the toggle and language selector backgrounds in each mode', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config({
				themeToggleBackgroundColor: '#111111',
				languageSelectBackgroundColor: '#eeeeee',
				darkColors: {
					theme_toggle_background: '#f5f5f5',
					language_select_background: '#222222'
				}
			})
		);
		expect(store.themeToggleTextColor).toBe('#ffffff');
		expect(store.languageSelectTextColor).toBe('#000000');
		expect(html().style.getPropertyValue('--login-theme-toggle-background-color')).toBe('#111111');
		expect(html().style.getPropertyValue('--login-language-select-text-color')).toBe('#000000');
		store.setColourMode('dark');
		expect(store.themeToggleTextColor).toBe('#000000');
		expect(store.languageSelectTextColor).toBe('#ffffff');
		expect(html().style.getPropertyValue('--login-theme-toggle-background-color')).toBe('#f5f5f5');
		expect(html().style.getPropertyValue('--login-language-select-background-color')).toBe(
			'#222222'
		);
		store.setFromUIConfig(config({ themeToggleBackgroundColor: 'url(x)' }));
		expect(html().style.getPropertyValue('--login-theme-toggle-background-color')).toBe('');
		expect(html().style.getPropertyValue('--login-theme-toggle-text-color')).toBe('');
	});

	it('applies the image opacities and the brand panel image', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: null,
						backgroundImageOpacity: 35,
						brandPanelImageUrl: 'https://example.com/panel.jpg',
						brandPanelImageOpacity: 55,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);

		expect(store.backgroundImageOpacity).toBe(35);
		expect(store.brandPanelImageOpacity).toBe(55);
		expect(html().style.getPropertyValue('--login-page-background-opacity')).toBe('0.35');
		expect(html().style.getPropertyValue('--login-brand-panel-image-opacity')).toBe('0.55');
		expect(html().style.getPropertyValue('--login-brand-panel-image-layer')).toBe(
			'url("https://example.com/panel.jpg")'
		);
		expect(html().getAttribute('data-has-brand-panel-image')).toBe('true');
	});

	it('shows the same pictures in both modes, each darkened in dark mode by its own dimming', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: 'https://example.com/light-bg.jpg',
						loginPanelBackgroundImageUrl: 'https://example.com/light-form.jpg',
						brandPanelImageUrl: 'https://example.com/panel.jpg',
						backgroundImageDarkDim: 40,
						loginPanelBackgroundDarkDim: 20,
						brandPanelImageDarkDim: 30,
						loginPanelBackgroundImageFilters: [{ name: 'invert', value: 100 }],
						brandPanelImageFilters: [
							{ name: 'grayscale', value: 100 },
							{ name: 'blur', value: 2 }
						],
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);
		const veil = (dim: number) => `linear-gradient(rgb(0 0 0 / ${dim}%), rgb(0 0 0 / ${dim}%))`;
		expect(store.backgroundImageDimLayer).toBeNull();
		expect(html().style.getPropertyValue('--login-page-image-dim')).toBe('');
		// In light mode, the form-area and brand panel pictures take their own filters.
		expect(store.loginPanelBackgroundFilter).toBe('invert(100%)');
		expect(store.brandPanelImageFilter).toBe('grayscale(100%) blur(2px)');
		expect(html().style.getPropertyValue('--login-panel-background-filter')).toBe('invert(100%)');
		store.setColourMode('dark');
		expect(store.backgroundImageUrl).toBe('https://example.com/light-bg.jpg');
		expect(store.loginPanelBackgroundImageUrl).toBe('https://example.com/light-form.jpg');
		// Each picture by its own dimming.
		expect(store.backgroundImageDimLayer).toBe(veil(40));
		// The pictures on their own elements are darkened after their filters (an inverted picture
		// is darkened, the darkening not inverted).
		expect(store.loginPanelBackgroundFilter).toBe('invert(100%) brightness(80%)');
		expect(store.brandPanelImageFilter).toBe('grayscale(100%) blur(2px) brightness(70%)');
		expect(html().style.getPropertyValue('--login-page-image-dim')).toBe(veil(40));
		expect(html().style.getPropertyValue('--login-panel-background-filter')).toBe(
			'invert(100%) brightness(80%)'
		);
		expect(html().style.getPropertyValue('--login-brand-panel-image-filter')).toBe(
			'grayscale(100%) blur(2px) brightness(70%)'
		);
		store.setColourMode('light');
		expect(html().style.getPropertyValue('--login-page-image-dim')).toBe('');
		expect(store.loginPanelBackgroundFilter).toBe('invert(100%)');
	});

	it('darkens nothing with no dimming, nor where there is no picture', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: 'https://example.com/light-bg.jpg',
						backgroundImageDarkDim: 0,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);
		store.setColourMode('dark');
		expect(store.backgroundImageDimLayer).toBeNull();
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: null,
						backgroundImageDarkDim: 60,
						loginPanelBackgroundDarkDim: 60,
						brandPanelImageDarkDim: 60,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);
		expect(store.backgroundImageDimLayer).toBeNull();
		expect(store.loginPanelBackgroundFilter).toBe('');
		expect(store.brandPanelImageFilter).toBe('');
	});

	it('takes an older server’s grayscale switches as the pictures’ filters', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{ loginPanelBackgroundGrayscale: true },
				{
					appearance: {
						backgroundImageUrl: null,
						loginPanelBackgroundImageUrl: 'https://example.com/form.jpg',
						brandPanelImageUrl: 'https://example.com/panel.jpg',
						brandPanelImageGrayscale: true,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);
		expect(store.loginPanelBackgroundFilter).toBe('grayscale(100%)');
		expect(store.brandPanelImageFilter).toBe('grayscale(100%)');
	});

	it('shows the dark logo in dark mode, and the light logo where none is set', () => {
		const branding = createBrandingStore();
		branding.set('Example', 'https://example.com/light-logo.png', 'https://example.com/dark.png');
		expect(branding.logoUrl).toBe('https://example.com/light-logo.png');
		branding.setColourMode('dark');
		expect(branding.logoUrl).toBe('https://example.com/dark.png');
		branding.set('Example', 'https://example.com/light-logo.png', null);
		expect(branding.logoUrl).toBe('https://example.com/light-logo.png');
	});

	it('refuses a brand panel image that is not a safe image URL', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: null,
						brandPanelImageUrl: 'http://example.com/panel.jpg',
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);

		expect(store.brandPanelImageUrl).toBeNull();
		expect(html().style.getPropertyValue('--login-brand-panel-image-layer')).toBe('');
		expect(html().getAttribute('data-has-brand-panel-image')).toBe('false');
	});

	it('writes a hostile image URL as one url() string, not as more declarations', () => {
		const store = createLoginUIPageStore();
		const hostile = 'https://example.com/a"); color:red; --extra:url("https://example.com/b';
		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: hostile,
						brandPanelImageUrl: hostile,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);

		for (const name of ['--login-page-background-layer', '--login-brand-panel-image-layer']) {
			expect(html().style.getPropertyValue(name), name).toContain('%22');
		}
		expect(html().style.getPropertyValue('color')).toBe('');
		expect(html().style.getPropertyValue('--extra')).toBe('');
		expect(store.backgroundImageLayer).toContain('%22');
		expect(store.brandPanelImageLayer).toContain('%22');
	});

	it('survives image URLs that are not strings', () => {
		const store = createLoginUIPageStore();
		expect(() =>
			store.setFromUIConfig(
				config(
					{},
					{
						appearance: {
							backgroundImageUrl: 123 as never,
							loginPanelBackgroundImageUrl: {} as never,
							brandPanelImageUrl: 123 as never,
							customCss: null,
							headerText: null,
							footerText: null,
							footerLinks: [],
							customBlocks: []
						}
					}
				)
			)
		).not.toThrow();
		expect(store.backgroundImageUrl).toBeNull();
		expect(store.brandPanelImageUrl).toBeNull();
		expect(store.backgroundImageLayer).toBeNull();
	});

	it('defaults the opacities to fully clear and bounds them to 0-100', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({}));
		expect(store.backgroundImageOpacity).toBe(100);
		expect(store.brandPanelImageOpacity).toBe(100);

		store.setFromUIConfig(
			config(
				{},
				{
					appearance: {
						backgroundImageUrl: null,
						backgroundImageOpacity: 250,
						brandPanelImageOpacity: -5,
						customCss: null,
						headerText: null,
						footerText: null,
						footerLinks: [],
						customBlocks: []
					}
				}
			)
		);
		expect(store.backgroundImageOpacity).toBe(100);
		expect(store.brandPanelImageOpacity).toBe(0);
	});

	it('resolves the brand panel logo display, following the form side on inherit', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ logoDisplay: 'text', brandPanelLogoDisplay: 'inherit' }));
		expect(store.brandPanelLogoDisplay).toBe('text');
		expect(html().getAttribute('data-brand-panel-logo-display')).toBe('text');

		store.setFromUIConfig(config({ logoDisplay: 'text', brandPanelLogoDisplay: 'image' }));
		expect(store.brandPanelLogoDisplay).toBe('image');

		store.setFromUIConfig(config({ logoDisplay: 'hidden' }));
		expect(store.brandPanelLogoDisplay).toBe('hidden');
	});

	it('reads the header name', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config({}, { branding: { brandName: 'Example', logoUrl: null, headerName: '  Console  ' } })
		);

		expect(store.headerName).toBe('Console');
		store.setFromUIConfig(config({}));
		expect(store.headerName).toBe('');
	});

	it('keeps the form-row topbar positions on the split template', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ template: 'split', topbarPosition: 'form_bottom_center' }));

		expect(store.topbarPosition).toBe('form_bottom_center');
		expect(html().getAttribute('data-topbar-position')).toBe('form_bottom_center');
	});

	it.each(['standard', 'minimal'] as const)(
		'reads form-row topbar positions as the page bottom on the %s template',
		(template) => {
			const store = createLoginUIPageStore();
			store.setFromUIConfig(config({ template, topbarPosition: 'form_bottom_right' }));

			expect(store.topbarPosition).toBe('bottom_right');
			expect(html().getAttribute('data-topbar-position')).toBe('bottom_right');
		}
	);

	it('marks a form area colour that is set', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ formAreaColor: '#ffffff80' }));
		expect(html().getAttribute('data-has-form-area-color')).toBe('true');

		store.setFromUIConfig(config({ formAreaColor: '' }));
		expect(html().getAttribute('data-has-form-area-color')).toBe('false');
	});

	it('marks a tenant accent that is set (Clear glass keeps its reflection from behind the label)', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ accentColor: '#747474' }));
		expect(html().getAttribute('data-has-accent-color')).toBe('true');

		store.setFromUIConfig(config({ accentColor: 'not-a-colour' }));
		expect(html().getAttribute('data-has-accent-color')).toBe('false');

		store.setFromUIConfig(config({ accentColor: '' }));
		expect(html().getAttribute('data-has-accent-color')).toBe('false');
	});

	it('keeps the brand panel as the stage behind a floating card, even with no brand content', () => {
		const store = createLoginUIPageStore();
		const split = { template: 'split', layout: 'split_panel' } as const;

		store.setFromUIConfig(config({ ...split, brandContentMode: 'logo_copy' }));
		expect(store.showBrandPanel).toBe(true);

		// No brand content: no panel beside a full-height form side...
		store.setFromUIConfig(config({ ...split, brandContentMode: 'none', formFrame: 'full' }));
		expect(store.showBrandPanel).toBe(false);

		// ...but under the card the panel is the stage (its picture and colour), with nothing on it.
		store.setFromUIConfig(config({ ...split, brandContentMode: 'none', formFrame: 'card' }));
		expect(store.showBrandPanel).toBe(true);

		// Other templates never have a panel.
		store.setFromUIConfig(config({ template: 'standard', formFrame: 'card' }));
		expect(store.showBrandPanel).toBe(false);
	});

	it('withdraws the mode switch when a light or dark mode is fixed', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(config({ themeToggleEnabled: true, languageSelectEnabled: false }));
		expect(store.themeToggleEnabled).toBe(true);
		expect(store.showTopbar).toBe(true);

		store.setFromUIConfig(
			config(
				{ themeToggleEnabled: true, languageSelectEnabled: false },
				{ theme: 'dark', themeFixed: true }
			)
		);
		expect(store.themeToggleEnabled).toBe(false);
		expect(store.showTopbar).toBe(false);

		store.setFromUIConfig(
			config(
				{ themeToggleEnabled: true, languageSelectEnabled: true },
				{ theme: 'light', themeFixed: true }
			)
		);
		expect(store.showTopbar).toBe(true);
	});

	it('does not withdraw the mode switch for auto: it cannot be fixed', () => {
		const store = createLoginUIPageStore();
		store.setFromUIConfig(
			config(
				{ themeToggleEnabled: true, languageSelectEnabled: false },
				{ theme: 'auto', themeFixed: true }
			)
		);
		expect(store.themeToggleEnabled).toBe(true);
		expect(store.showTopbar).toBe(true);
	});
});
