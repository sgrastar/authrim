import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AuthenticationMethodsResponse } from '$lib/api/authentication-methods';
import Layout from './+layout.svelte';
import { getLocale, setLocale } from '$i18n/i18n-svelte';

function authenticationMethods(): AuthenticationMethodsResponse {
	return {
		methods: {} as AuthenticationMethodsResponse['methods'],
		ui: {
			theme: 'dark',
			variant: 'navy',
			themeTemplate: 'split-brand-panel',
			branding: {
				brandName: 'Example Identity',
				logoUrl: 'https://cdn.example.com/logo.png',
				faviconUrl: null
			},
			pageTemplate: {
				layout: 'split_panel',
				fontFamily: 'serif',
				fontScale: 'compact',
				backgroundColor: '#112233',
				titleColor: '#fefefe',
				textColor: '#eeeeee',
				copyColor: '#cccccc',
				logoDisplay: 'auto',
				logoLayout: 'row',
				headerEnabled: true,
				subtitleEnabled: true,
				footerEnabled: true,
				poweredByEnabled: true,
				authSwitchLinkEnabled: true,
				topbarPosition: 'bottom_right',
				themeToggleEnabled: true,
				languageSelectEnabled: true,
				languageSwitcherPosition: 'below_card',
				headerStyle: 'center',
				footerStyle: 'simple',
				splitFrame: 'full',
				splitPanelSide: 'right',
				splitPanelWidth: 'wide',
				splitBackgroundMode: 'panel',
				loginPanelBackgroundColor: '#223344',
				loginPanelBackgroundGradientColor: '#445566',
				loginPanelBackgroundOpacity: 60,
				brandContentMode: 'logo_copy',
				brandPosition: 'center',
				brandAlign: 'center',
				brandPanelTitle: 'Welcome',
				brandPanelText: 'Use your account to continue.'
			},
			appearance: {
				backgroundImageUrl: 'https://cdn.example.com/background.webp',
				loginPanelBackgroundImageUrl: 'https://cdn.example.com/panel.webp',
				customCss: '.auth-page { opacity: 0.99; }',
				headerText: null,
				footerText: null,
				footerLinks: [],
				customBlocks: []
			},
			supportedLocales: ['en', 'ja'],
			defaultLocale: 'en'
		},
		meta: { cacheTTL: 60, revision: 'theme-revision' }
	};
}

const children = createRawSnippet(() => ({ render: () => '<main data-test-child></main>' }));

describe('Login UI layout SSR theme bootstrap', () => {
	it('applies the server-selected locale before rendering child content', () => {
		setLocale('en');
		const localizedChildren = createRawSnippet(() => ({
			render: () => `<span data-locale>${getLocale()}</span>`
		}));
		const { body } = render(Layout, {
			props: {
				children: localizedChildren,
				data: {
					preferredLanguage: 'fr',
					shouldLoadTenantBranding: false,
					authenticationMethods: null
				} as never
			}
		});

		expect(body).toContain('<span data-locale>fr</span>');
	});

	it('renders the configured tenant theme into the initial HTML', () => {
		const { body } = render(Layout, {
			props: {
				children,
				data: {
					preferredLanguage: 'en',
					shouldLoadTenantBranding: true,
					authenticationMethods: authenticationMethods()
				} as never
			}
		});

		expect(body).toContain('data-theme="dark"');
		expect(body).toContain('data-variant="navy"');
		expect(body).toContain('data-login-theme="split-brand-panel"');
		expect(body).toContain('data-page-layout="split_panel"');
		expect(body).toContain('data-split-panel-side="right"');
		expect(body).toContain('data-split-panel-width="wide"');
		expect(body).toContain('data-split-background-mode="panel"');
		expect(body).toContain('data-has-page-background-image="true"');
		expect(body).toContain('data-has-login-panel-background-image="true"');
		expect(body).toContain('--login-page-background-color: #112233');
		expect(body).toContain(
			'--login-page-background-layer: url(&quot;https://cdn.example.com/background.webp&quot;)'
		);
		expect(body).toContain(
			'--login-panel-background-layer: url(&quot;https://cdn.example.com/panel.webp&quot;)'
		);
		expect(body).toContain('--login-panel-background-opacity: 0.6');
		expect(body).toContain('id="authrim-login-ui-custom-css"');
		expect(body).toContain('.auth-page { opacity: 0.99; }');
	});

	it('does not leak a previous tenant theme into the next SSR render', () => {
		render(Layout, {
			props: {
				children,
				data: {
					preferredLanguage: 'en',
					shouldLoadTenantBranding: true,
					authenticationMethods: authenticationMethods()
				} as never
			}
		});

		const { body } = render(Layout, {
			props: {
				children,
				data: {
					preferredLanguage: 'en',
					shouldLoadTenantBranding: false,
					authenticationMethods: null
				} as never
			}
		});

		expect(body).toContain('data-theme="light"');
		expect(body).toContain('data-login-theme="meridian"');
		expect(body).not.toContain('split-brand-panel');
		expect(body).not.toContain('Example Identity');
	});
});
