import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountSecuritySection from './AccountSecuritySection.svelte';

const source = readFileSync(
	fileURLToPath(new URL('./AccountSecuritySection.svelte', import.meta.url)),
	'utf8'
);

const handlers = {
	onRefresh: () => undefined,
	onRevokeSession: (_id: string) => undefined,
	onAddPasskey: (_deviceName: string) => undefined,
	onDeletePasskey: (_id: string) => undefined,
	onStartTotpEnrollment: (_label: string) => undefined,
	onActivateTotpEnrollment: (_code: string) => undefined,
	onDeleteTotpCredential: (_id: string, _code: string) => undefined,
	onRegenerateTotpBackupCodes: (_code: string) => undefined,
	onClearTotpEnrollment: () => undefined,
	onReauth: () => undefined
};

describe('AccountSecuritySection session inventory', () => {
	it('shows browser, OS, an English country name, and never renders the raw session ID', () => {
		setLocale('ja');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['sessions'],
				sessions: [
					{
						id: 'g1:weur:2:session_private_identifier',
						current: true,
						created_at: Date.UTC(2026, 7, 8, 5, 20, 36),
						expires_at: Date.UTC(2026, 7, 9, 5, 20, 36),
						browser: 'Safari',
						os: 'iOS',
						device_type: 'mobile',
						country_code: 'JP'
					}
				]
			}
		}).body;

		expect(body).toContain('ログイン中の端末');
		expect(body).toContain('Safari / iOS');
		expect(body).toContain('国・地域: Japan');
		expect(body).not.toContain('日本');
		expect(body).toContain('この端末');
		expect(body).not.toContain('session_private_identifier');
	});

	it('keeps country names in English for right-to-left UI locales', () => {
		setLocale('ar');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['sessions'],
				sessions: [
					{
						id: 'session-arabic-ui',
						current: false,
						created_at: Date.UTC(2026, 7, 8, 5, 20, 36),
						expires_at: Date.UTC(2026, 7, 9, 5, 20, 36),
						browser: 'Safari',
						os: 'macOS',
						device_type: 'desktop',
						country_code: 'JP'
					}
				]
			}
		}).body;

		expect(body).toContain('Japan');
		expect(body).not.toContain('اليابان');
		expect(body).not.toContain('session-arabic-ui');
	});

	it('omits location when the edge did not provide a country', () => {
		setLocale('en');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['sessions'],
				sessions: [
					{
						id: 'g1:weur:2:session_without_country',
						current: false,
						created_at: Date.UTC(2026, 7, 8, 5, 20, 36),
						expires_at: Date.UTC(2026, 7, 9, 5, 20, 36),
						browser: null,
						os: null,
						device_type: null,
						country_code: null
					}
				]
			}
		}).body;

		expect(body).toContain('Device details unavailable');
		expect(body).not.toContain('Location:');
		expect(body).not.toContain('session_without_country');
	});

	it('explains that connected devices are separate from browser sign-ins', () => {
		setLocale('ja');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['devices'],
				devices: []
			}
		}).body;

		expect(body).toContain('連携済みアプリ・端末');
		expect(body).toContain('アカウントに連携したアプリと端末です');
		expect(body).toContain('連携済みのアプリ・端末はありません');
	});

	it('shows a skeleton instead of a false empty state while an area is loading', () => {
		setLocale('en');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['sessions'],
				loadingAreas: ['sessions'],
				sessions: []
			}
		}).body;

		expect(body).toContain('aria-busy="true"');
		expect(body).toContain('account-section-skeleton');
		expect(body).not.toContain('No items');
	});

	it('shows the authenticator provider and registration time without the technical device label', () => {
		setLocale('en');
		const body = render(AccountSecuritySection, {
			props: {
				...handlers,
				areas: ['passkeys'],
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
		}).body;

		expect(body).toContain('Apple Passwords');
		expect(body).toContain('passkey-provider-icon__light');
		expect(body).toContain('passkey-provider-icon__dark');
		expect(body).not.toContain('Direct Auth Passkey');
		expect(body).not.toContain('passkey-private-identifier');
		expect(body).toContain('8/9/2026');
		expect(body).not.toContain('8/10/2026');
	});

	it('keeps the provider icon aligned to both passkey detail rows at the action height', () => {
		expect(source).toContain('grid-template-columns: 36px minmax(0, 1fr)');
		expect(source).toContain('grid-row: 1 / span 2');
		expect(source).toContain('width: 36px;');
		expect(source).toContain('height: 36px;');
	});

	it('refreshes only the security areas rendered by this widget', () => {
		expect(source).toContain('onclick={() => onRefresh(areas)}');
	});
});
