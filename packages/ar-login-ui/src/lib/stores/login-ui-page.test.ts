// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginUIConfig } from '$lib/api/authentication-methods';
import { createLoginUIPageStore } from './login-ui-page.svelte';

vi.mock('$app/environment', () => ({ browser: true }));

describe('loginUIPageStore', () => {
	beforeEach(() => {
		document.documentElement.removeAttribute('style');
		document.documentElement.setAttribute('data-theme', 'dark');
		document.documentElement.setAttribute('data-login-theme', 'meridian');
		const themeColor = document.querySelector("meta[name='theme-color']");
		if (themeColor) themeColor.remove();
		const newThemeColor = document.createElement('meta');
		newThemeColor.name = 'theme-color';
		document.head.appendChild(newThemeColor);
		document.body.style.backgroundColor = '';
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
				accentColor: '#336699',
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
				textLocalizations: {
					en: {
						tagline: 'Saved English tagline',
						loginTitle: 'Custom sign in',
						registrationTitle: 'Custom registration',
						accountTitle: 'Custom account',
						brandPanelTitle: 'Localized brand title',
						brandPanelText: 'Localized brand text',
						footerText: 'Localized footer text'
					},
					ja: { tagline: '保存した日本語タグライン' },
					fr: { tagline: '   ', brandPanelTitle: '', footerText: ' ' }
				},
				footerText: 'Saved footer text',
				footerLinks: [{ label: 'Privacy', url: 'https://example.com/privacy' }],
				customBlocks: []
			},
			supportedLocales: ['en', 'ja'],
			defaultLocale: 'en'
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
		expect(html.style.backgroundColor).toBe('rgb(17, 34, 51)');
		expect(document.body.style.backgroundColor).toBe('rgb(17, 34, 51)');
		expect(document.querySelector("meta[name='theme-color']")?.getAttribute('content')).toBe(
			'#112233'
		);
		expect(html.style.getPropertyValue('--login-accent-color')).toBe('#336699');
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
		expect(loginUIPageStore.getLocalizedText('en', 'tagline')).toBe('Saved English tagline');
		expect(loginUIPageStore.getLocalizedText('en', 'loginTitle')).toBe('Custom sign in');
		expect(loginUIPageStore.getLocalizedText('en', 'registrationTitle')).toBe(
			'Custom registration'
		);
		expect(loginUIPageStore.getLocalizedText('en', 'accountTitle')).toBe('Custom account');
		expect(loginUIPageStore.getLocalizedText('ja', 'loginTitle')).toBeNull();
		expect(loginUIPageStore.getLocalizedText('ja', 'tagline')).toBe('保存した日本語タグライン');
		expect(loginUIPageStore.getLocalizedText('fr', 'tagline')).toBe('');
		expect(loginUIPageStore.getLocalizedText('fr', 'brandPanelTitle')).toBe('');
		expect(loginUIPageStore.getLocalizedText('fr', 'footerText')).toBe('');
		expect(loginUIPageStore.getLocalizedText('de', 'tagline')).toBe('Saved header text');
		expect(loginUIPageStore.getLocalizedText('en', 'brandPanelTitle')).toBe(
			'Localized brand title'
		);
		expect(loginUIPageStore.getLocalizedText('en', 'brandPanelText')).toBe('Localized brand text');
		expect(loginUIPageStore.getLocalizedText('en', 'footerText')).toBe('Localized footer text');
		expect(loginUIPageStore.getLocalizedText('ja', 'brandPanelTitle')).toBe('Saved brand title');
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
