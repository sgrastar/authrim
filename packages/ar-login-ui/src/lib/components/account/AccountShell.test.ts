import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import { buildLoginUIConfig, type LoginUIOverrides } from '$lib/storybook/config';
import { applyAuthenticationMethodsToLoginUI } from '$lib/stores/login-ui-configuration';
import type { AuthenticationMethodsResponse } from '$lib/api/authentication-methods';
import WithLoginUIStores from '$lib/testing/WithLoginUIStores.svelte';
import AccountShell from './AccountShell.svelte';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

const source = readFileSync(new URL('./AccountShell.svelte', import.meta.url), 'utf8');

const html = (markup: string) => createRawSnippet(() => ({ render: () => markup }));

function renderShell(
	props: Partial<Parameters<typeof AccountShell>[1]> = {},
	ui?: LoginUIOverrides
): { body: string; head: string } {
	const result = render(WithLoginUIStores, {
		props: {
			component: AccountShell,
			props: {
				title: 'Account',
				onLogout: () => undefined,
				children: html('<p class="grid-content">Widgets</p>'),
				...props
			},
			setup: ui
				? (stores) =>
						applyAuthenticationMethodsToLoginUI(
							{
								methods: {} as AuthenticationMethodsResponse['methods'],
								ui: buildLoginUIConfig({ theme: 'meridian', scheme: 'light' }, ui),
								meta: { cacheTTL: 0, revision: 'test' }
							},
							stores
						)
				: undefined
		}
	});
	return { body: result.body.replace(HYDRATION_MARKERS, ''), head: result.head };
}

describe('AccountShell', () => {
	beforeEach(() => setLocale('en'));

	it('draws the brand, title, description and sign-out above the grid content', () => {
		const { body, head } = renderShell({
			brandName: 'Acme ID',
			title: 'Your account',
			description: 'Manage how you sign in.'
		});

		expect(head).toContain('<title>Your account - Acme ID</title>');
		expect(body).toMatch(/class="account-kicker[^"]*">Acme ID<\/p>/);
		expect(body).toMatch(/<h1[^>]*>Your account<\/h1>/);
		expect(body).toMatch(/class="account-description[^"]*">Manage how you sign in\.<\/p>/);
		expect(body).toMatch(/<button[^>]*>[\s\S]*Sign out[\s\S]*<\/button>/);
		expect(body).toMatch(/<section class="account-grid[^"]*"[^>]*>\s*<p class="grid-content">/);
	});

	it('falls back to the product name and leaves out an empty description', () => {
		const { body, head } = renderShell({ title: '' });

		expect(head).toContain('<title>Account - Authrim</title>');
		expect(body).toMatch(/class="account-kicker[^"]*">Authrim<\/p>/);
		expect(body).not.toContain('account-description');
	});

	it('marks the grid busy while it loads and announces a page error', () => {
		expect(renderShell({ busy: true }).body).toMatch(/class="account-grid[^"]*" aria-busy="true"/);
		expect(renderShell().body).toMatch(/class="account-grid[^"]*" aria-busy="false"/);
		expect(renderShell({ pageError: 'Could not load the account.' }).body).toMatch(
			/role="alert"[^>]*>Could not load the account\./
		);
		expect(renderShell().body).not.toContain('role="alert"');
	});

	it('spins the sign-out button while signing out', () => {
		expect(renderShell({ logoutLoading: true }).body).toMatch(
			/<button[^>]*disabled[^>]*aria-busy="true"[^>]*>[\s\S]*Sign out/
		);
	});

	it('shares the configured footer and preference controls with authentication pages', () => {
		const { body } = renderShell();
		expect(body).toMatch(/class="account-preferences[^"]*" data-position="below_card"/);
		expect(body).toContain('class="theme-toggle');
		expect(body).toContain('class="auth-lang-select');
		expect(body).toMatch(/<footer class="auth-footer account-footer[^"]*"/);

		const pinned = renderShell({}, { pageTemplate: { topbarPosition: 'top_right' } }).body;
		expect(pinned).toMatch(/class="account-preferences[^"]*" data-position="top_right"/);

		const languageOnly = renderShell({}, { pageTemplate: { themeToggleEnabled: false } }).body;
		expect(languageOnly).not.toContain('class="theme-toggle');
		expect(languageOnly).toContain('class="auth-lang-select');

		const hidden = renderShell(
			{},
			{ pageTemplate: { topbarPosition: 'hidden', footerEnabled: false } }
		).body;
		expect(hidden).not.toContain('account-preferences');
		expect(hidden).not.toContain('account-footer');
	});

	it('draws a dialog inside the shell so it shares the flat surfaces', () => {
		const { body } = renderShell({ dialog: html('<div role="dialog">Re-authenticate</div>') });
		expect(body).toMatch(/class="account-shell[^"]*"[\s\S]*<div role="dialog">[\s\S]*<\/div>$/);
	});

	it('fills the dynamic viewport and flattens surfaces through properties, not overrides', () => {
		expect(source).toContain('min-height: 100dvh');
		expect(source).not.toContain('min-height: 100vh');
		expect(source).not.toContain('!important');
		for (const property of [
			'--card-surface',
			'--card-shadow',
			'--control-surface',
			'--surface-backdrop-filter',
			'--surface-transition',
			'--surface-hover-transform'
		]) {
			expect(source).toContain(`${property}:`);
		}
	});
});
