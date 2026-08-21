// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginUIConfig } from '$lib/api/authentication-methods';
import { createLoginUIPageStore } from './login-ui-page.svelte';

vi.mock('$app/environment', () => ({ browser: true }));

describe('loginUIPageStore', () => {
	beforeEach(() => {
		document.documentElement.removeAttribute('style');
		document.getElementById('authrim-login-ui-custom-css')?.remove();
	});

	it('applies every page-template setting consumed by the Login UI', () => {
		const loginUIPageStore = createLoginUIPageStore();
		const config: LoginUIConfig = {
			theme: 'dark',
			variant: 'navy',
			themeTemplate: 'split-brand-panel',
			branding: {
				brandName: 'Example',
				logoUrl: 'https://example.com/logo.png',
				faviconUrl: 'https://example.com/favicon.ico'
			},
			pageTemplate: {
				layout: 'split_panel',
				fontFamily: 'mono',
				fontScale: 'spacious',
				backgroundColor: '#112233',
				titleColor: '#fefefe',
				textColor: '#e1e2e3',
				copyColor: '#a1a2a3',
				logoDisplay: 'text',
				logoLayout: 'row',
				headerEnabled: false,
				subtitleEnabled: false,
				footerEnabled: false,
				poweredByEnabled: false,
				authSwitchLinkEnabled: false,
				topbarPosition: 'in_card',
				themeToggleEnabled: false,
				languageSelectEnabled: false,
				languageSwitcherPosition: 'top_right',
				headerStyle: 'bar',
				footerStyle: 'bar',
				splitFrame: 'card',
				splitPanelSide: 'right',
				splitPanelWidth: 'wide',
				splitBackgroundMode: 'panel',
				loginPanelBackgroundColor: '#102030',
				loginPanelBackgroundGradientColor: '#304050',
				loginPanelBackgroundOpacity: 45,
				brandContentMode: 'logo',
				brandPosition: 'top',
				brandAlign: 'right',
				brandPanelTitle: 'Saved brand title',
				brandPanelText: 'Saved brand text'
			},
			appearance: {
				backgroundImageUrl: 'https://example.com/background.jpg',
				loginPanelBackgroundImageUrl: 'https://example.com/panel.jpg',
				thumbnailUrl: 'https://example.com/thumbnail.webp',
				customCss: '.auth-page { opacity: 0.99; }',
				headerText: 'Saved header text',
				footerText: 'Saved footer text',
				footerLinks: [{ label: 'Privacy', url: 'https://example.com/privacy' }],
				customBlocks: []
			},
			supportedLocales: ['en', 'ja']
		};

		loginUIPageStore.setFromUIConfig(config);

		const html = document.documentElement;
		expect(html.getAttribute('data-login-theme')).toBe('split-brand-panel');
		expect(html.getAttribute('data-page-layout')).toBe('split_panel');
		expect(html.getAttribute('data-font-family')).toBe('mono');
		expect(html.getAttribute('data-font-scale')).toBe('spacious');
		expect(html.getAttribute('data-language-switcher-position')).toBe('top_right');
		expect(html.getAttribute('data-topbar-position')).toBe('in_card');
		expect(html.getAttribute('data-header-style')).toBe('bar');
		expect(html.getAttribute('data-footer-style')).toBe('bar');
		expect(html.getAttribute('data-logo-layout')).toBe('row');
		expect(html.getAttribute('data-split-frame')).toBe('card');
		expect(html.getAttribute('data-split-panel-side')).toBe('right');
		expect(html.getAttribute('data-split-panel-width')).toBe('wide');
		expect(html.getAttribute('data-split-background-mode')).toBe('panel');
		expect(html.getAttribute('data-has-page-background-image')).toBe('true');
		expect(html.getAttribute('data-has-login-panel-background-image')).toBe('true');
		expect(html.getAttribute('data-brand-content-mode')).toBe('logo');
		expect(html.getAttribute('data-brand-position')).toBe('top');
		expect(html.getAttribute('data-brand-align')).toBe('right');
		expect(html.getAttribute('data-logo-display')).toBe('text');
		expect(html.style.getPropertyValue('--login-page-background-color')).toBe('#112233');
		expect(html.style.getPropertyValue('--login-title-color')).toBe('#fefefe');
		expect(html.style.getPropertyValue('--login-text-color')).toBe('#e1e2e3');
		expect(html.style.getPropertyValue('--login-copy-color')).toBe('#a1a2a3');
		expect(html.style.getPropertyValue('--login-page-background-layer')).toBe(
			'url("https://example.com/background.jpg")'
		);
		expect(html.style.getPropertyValue('--login-panel-background-layer')).toBe(
			'url("https://example.com/panel.jpg")'
		);
		expect(html.style.getPropertyValue('--login-panel-background-fill')).toBe(
			'linear-gradient(135deg, #102030, #304050)'
		);
		expect(html.style.getPropertyValue('--login-panel-background-opacity')).toBe('0.45');
		expect(document.getElementById('authrim-login-ui-custom-css')?.textContent).toBe(
			'.auth-page { opacity: 0.99; }'
		);
		expect(loginUIPageStore.logoLayout).toBe('row');
		expect(loginUIPageStore.headerEnabled).toBe(false);
		expect(loginUIPageStore.subtitleEnabled).toBe(false);
		expect(loginUIPageStore.footerEnabled).toBe(false);
		expect(loginUIPageStore.poweredByEnabled).toBe(false);
		expect(loginUIPageStore.authSwitchLinkEnabled).toBe(false);
		expect(loginUIPageStore.topbarPosition).toBe('in_card');
		expect(loginUIPageStore.showTopbar).toBe(false);
		expect(loginUIPageStore.brandContentMode).toBe('logo');
		expect(loginUIPageStore.logoDisplay).toBe('text');
		expect(loginUIPageStore.headerText).toBe('Saved header text');
		expect(loginUIPageStore.footerText).toBe('Saved footer text');
		expect(loginUIPageStore.footerLinks).toEqual([
			{ label: 'Privacy', url: 'https://example.com/privacy' }
		]);
		expect(loginUIPageStore.brandPanelTitle).toBe('Saved brand title');
		expect(loginUIPageStore.brandPanelText).toBe('Saved brand text');
		expect(loginUIPageStore.fontFamily).toBe('mono');
		expect(loginUIPageStore.fontScale).toBe('spacious');
		expect(loginUIPageStore.backgroundImageUrl).toBe('https://example.com/background.jpg');
		expect(loginUIPageStore.loginPanelBackgroundImageUrl).toBe('https://example.com/panel.jpg');
		expect(loginUIPageStore.splitBackgroundMode).toBe('panel');
		expect(loginUIPageStore.loginPanelBackgroundOpacity).toBe(45);
		expect(loginUIPageStore.splitPanelSide).toBe('right');
		expect(loginUIPageStore.splitPanelWidth).toBe('wide');
		expect(loginUIPageStore.customCss).toBe('.auth-page { opacity: 0.99; }');
	});
});
