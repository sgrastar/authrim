import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import type { AccountSession } from '$lib/api/account';
import AccountSessionsWidget from './AccountSessionsWidget.svelte';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

const session = (overrides: Partial<AccountSession> = {}): AccountSession => ({
	id: 'g1:weur:2:session_private_identifier',
	current: false,
	created_at: Date.UTC(2026, 7, 8, 5, 20, 36),
	expires_at: Date.UTC(2026, 7, 9, 5, 20, 36),
	browser: 'Safari',
	os: 'iOS',
	device_type: 'mobile',
	country_code: 'JP',
	...overrides
});

function renderSessions(props: Partial<Parameters<typeof AccountSessionsWidget>[1]> = {}) {
	return render(AccountSessionsWidget, {
		props: { onRevokeSession: () => undefined, ...props }
	}).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountSessionsWidget', () => {
	it('shows browser, OS, an English country name, and never renders the raw session ID', () => {
		setLocale('ja');
		const body = renderSessions({ sessions: [session({ current: true })] });

		expect(body).toContain('ログイン中の端末');
		expect(body).toContain('Safari / iOS');
		expect(body).toContain('国・地域: Japan');
		expect(body).not.toContain('日本');
		expect(body).toContain('この端末');
		expect(body).not.toContain('session_private_identifier');
	});

	it('names the location and sign-in time as text, not as aria-label on a span', () => {
		setLocale('en');
		const body = renderSessions({ sessions: [session()] });

		expect(body).toContain('Location: Japan');
		expect(body).toMatch(/Signed in \S/);
		expect(body).not.toMatch(/\saria-label=/);
	});

	it('keeps country names in English for right-to-left UI locales', () => {
		setLocale('ar');
		const body = renderSessions({
			sessions: [session({ id: 'session-arabic-ui', os: 'macOS', device_type: 'desktop' })]
		});

		expect(body).toContain('Japan');
		expect(body).not.toContain('اليابان');
		expect(body).not.toContain('session-arabic-ui');
	});

	it('omits location when the edge did not provide a country', () => {
		setLocale('en');
		const body = renderSessions({
			sessions: [
				session({
					id: 'g1:weur:2:session_without_country',
					browser: null,
					os: null,
					device_type: null,
					country_code: null
				})
			]
		});

		expect(body).toContain('Device details unavailable');
		expect(body).not.toContain('Location:');
		expect(body).not.toContain('session_without_country');
	});

	it('shows a skeleton instead of a false empty state while loading', () => {
		setLocale('en');
		const body = renderSessions({ loading: true, sessions: [] });

		expect(body).toContain('aria-busy="true"');
		expect(body).toContain('account-section-skeleton');
		expect(body).not.toContain('No items');
	});

	it('draws signing out of the current device as a destructive action', () => {
		setLocale('en');
		const body = renderSessions({ sessions: [session({ current: true })] });

		expect(body).toContain('btn-danger');
		expect(body).toContain('Sign out');
	});

	it('offers re-authentication with an alert when the error needs it', () => {
		setLocale('en');
		const body = renderSessions({
			error: 'Recent authentication is required.',
			reauthNeeded: true,
			onReauthenticate: () => undefined
		});

		expect(body).toMatch(/role="alert"[^>]*>Recent authentication is required\./);
		expect(body).toContain('Re-authenticate');
	});

	it('hides the refresh button when a parent panel refreshes instead', () => {
		setLocale('en');
		expect(renderSessions({ onRefresh: () => undefined })).toContain('Refresh');
		expect(renderSessions()).not.toContain('Refresh');
	});
});
