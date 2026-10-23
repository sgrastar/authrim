import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
import type { Locales } from '$i18n/i18n-types';
import { LOGIN_UI_LOCALES } from '$lib/i18n/locales';
import { errorPageMessage } from './error-page-message';

const LOGOUT_ERRORS = [
	'unregistered_post_logout_redirect_uri',
	'invalid_id_token_hint',
	'id_token_hint_required'
];

describe('errorPageMessage', () => {
	afterEach(() => {
		setLocale('en');
	});

	it('tells the user they are signed out and why they were not sent back to the app', () => {
		setLocale('en');
		const translations = get(LL);
		expect(errorPageMessage(translations, 'unregistered_post_logout_redirect_uri')).toBe(
			'You have been signed out. You could not be sent back to the app because its return address is not registered. Open the app again yourself.'
		);
		expect(errorPageMessage(translations, 'invalid_id_token_hint')).toBe(
			'You have been signed out. You could not be sent back to the app because its sign-out request could not be verified. Open the app again yourself.'
		);
		expect(errorPageMessage(translations, 'id_token_hint_required')).toBe(
			'You have been signed out. You could not be sent back to the app because its sign-out request was incomplete. Open the app again yourself.'
		);

		setLocale('ja');
		expect(errorPageMessage(get(LL), 'unregistered_post_logout_redirect_uri')).toBe(
			'ログアウトしました。アプリの戻り先が登録されていないため、アプリに戻れませんでした。アプリを開き直してください。'
		);
	});

	it('shows the rate-limit message for a rate-limit error', () => {
		setLocale('ja');
		expect(errorPageMessage(get(LL), 'slow_down')).toBe(
			'試行回数が多すぎます。しばらく待ってからもう一度お試しください。'
		);
	});

	it.each(['unknown', 'unknown_error', 'toString', '__proto__', ''])(
		'shows the unknown error for %j',
		(code) => {
			setLocale('en');
			expect(errorPageMessage(get(LL), code)).toBe('An unknown error occurred');
		}
	);

	it.each(LOGIN_UI_LOCALES as Locales[])(
		'has its own logout and rate-limit messages in %s',
		(locale) => {
			setLocale(locale);
			const translations = get(LL);
			const unknown = translations.error_unknown();
			for (const code of [...LOGOUT_ERRORS, 'slow_down']) {
				const message = errorPageMessage(translations, code);
				expect(message, `${locale}.${code}`).not.toBe('');
				expect(message, `${locale}.${code}`).not.toBe(unknown);
			}
			expect(translations.error_rateLimitedRetryAfter({ minutes: 15 })).toContain('15');
		}
	);
});
