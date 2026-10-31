import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountPasskeysWidget from './AccountPasskeysWidget.svelte';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

const handlers = {
	onAddPasskey: (_deviceName: string) => undefined,
	onDeletePasskey: (_id: string) => undefined
};

describe('AccountPasskeysWidget', () => {
	it('shows the authenticator provider and registration time without the technical device label', () => {
		setLocale('en');
		const body = render(AccountPasskeysWidget, {
			props: {
				...handlers,
				passkeySupported: true,
				passkeys: [
					{
						id: 'passkey-private-identifier',
						device_name: 'Direct Auth Passkey',
						aaguid: 'example-aaguid',
						provider: {
							aaguid: 'example-aaguid',
							name: 'Apple Passwords',
							icon_dark: 'https://example.com/apple-dark.png',
							icon_light: 'https://example.com/apple-light.png',
							known: true
						},
						created_at: Date.UTC(2026, 7, 9, 10, 30),
						last_used_at: Date.UTC(2026, 7, 10, 10, 30)
					}
				]
			}
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('Apple Passwords');
		expect(body).toContain('passkey-provider-icon__light');
		expect(body).toContain('passkey-provider-icon__dark');
		expect(body).toContain('apple-light.png');
		expect(body).toContain('apple-dark.png');
		expect(body).not.toContain('Direct Auth Passkey');
		expect(body).not.toContain('passkey-private-identifier');
		expect(body).toContain('8/9/2026');
		expect(body).not.toContain('8/10/2026');
		expect(body).toContain('btn-danger');
	});

	it('labels the name field and explains an unsupported browser', () => {
		setLocale('en');
		const body = render(AccountPasskeysWidget, { props: { ...handlers } }).body.replace(
			HYDRATION_MARKERS,
			''
		);

		expect(body).toMatch(/<label for="[^"]+"[^>]*>\s*Passkey name\s*<\/label>/);
		expect(body).toContain('This browser does not support passkey registration.');
		expect(body).toContain('No items');
	});

	it('shows a skeleton instead of the form and list while loading', () => {
		setLocale('en');
		const body = render(AccountPasskeysWidget, {
			props: { ...handlers, loading: true }
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('account-section-skeleton');
		expect(body).not.toContain('Passkey name');
	});
});
