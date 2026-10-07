import { get } from 'svelte/store';
import { afterEach, describe, expect, it } from 'vitest';
import { LL, setLocale } from '$i18n/i18n-svelte';
import type { Locales } from '$i18n/i18n-types';
import { LOGIN_UI_LOCALES } from '$lib/i18n/locales';
import {
	cibaApprovalErrorMessage,
	classifyApprovalFailure,
	deviceApprovalErrorMessage
} from './approval-errors';

const NEW_KEYS = [
	'device_errorConsentWithdrawn',
	'device_errorTryAgain',
	'device_errorTooManyAttempts',
	'ciba_errorConsentWithdrawn',
	'ciba_errorRequestGone',
	'ciba_errorTryAgain',
	'ciba_errorTooManyAttempts',
	'device_errorOutcomeUnknown',
	'ciba_errorOutcomeUnknown',
	'ciba_errorNoLongerWaiting'
] as const;

describe('approval failure classification', () => {
	it.each([
		// ar-async device API (POST /api/devices/lookup, /api/devices/verify)
		[{ error: 'invalid_code' }, 'invalid_code'],
		[{ error: 'consent_withdrawn' }, 'consent_withdrawn'],
		[{ error: 'temporarily_unavailable' }, 'retry'],
		[{ error: 'slow_down' }, 'rate_limited'],
		[{ error: 'authentication_required' }, 'login_required'],
		[{ error: 'server_error' }, 'failed'],
		[{ error: 'invalid_request' }, 'failed'],
		// ar-async CIBA API (POST /api/ciba/approve, /api/ciba/deny)
		[{ error: 'invalid_request', error_code: 'AR060004' }, 'request_gone'],
		[{ error: 'invalid_request', error_code: 'AR130003' }, 'request_gone'],
		[{ error: 'rate_limit_exceeded' }, 'rate_limited'],
		[{ error: 'login_required', error_code: 'AR000003' }, 'login_required'],
		[{ error: 'access_denied', error_code: 'AR050006' }, 'failed'],
		// Login UI transport: no answer, so a decision may or may not have been saved
		[{ error: 'network_error' }, 'unknown'],
		[{ error: 'timeout' }, 'unknown'],
		[undefined, 'failed']
	] as const)('reads %o as %s', (error, failure) => {
		expect(classifyApprovalFailure(error)).toBe(failure);
	});
});

describe('approval failure messages', () => {
	afterEach(() => {
		setLocale('en');
	});

	it('tells the person what to do for each device outcome', () => {
		setLocale('en');
		const t = get(LL);
		const message = (error: Parameters<typeof deviceApprovalErrorMessage>[1]) =>
			deviceApprovalErrorMessage(t, error, 'fallback');

		expect(message({ error: 'invalid_code' })).toBe(t.device_errorInvalidOrExpiredCode());
		expect(message({ error: 'consent_withdrawn' })).toBe(
			"This request was made before you withdrew this app's access. Start again on the device to get a new code."
		);
		expect(message({ error: 'temporarily_unavailable' })).toBe(t.device_errorTryAgain());
		expect(message({ error: 'slow_down' })).toBe(t.device_errorTooManyAttempts());
		expect(message({ error: 'authentication_required' })).toBe(t.error_login_required());
		expect(message({ error: 'server_error' })).toBe('fallback');
	});

	it('tells the person what to do for each CIBA outcome', () => {
		setLocale('en');
		const t = get(LL);
		const message = (error: Parameters<typeof cibaApprovalErrorMessage>[1]) =>
			cibaApprovalErrorMessage(t, error, 'fallback');

		expect(message({ error: 'consent_withdrawn' })).toBe(
			"This request was made before you withdrew this app's access. Start again from the app."
		);
		expect(message({ error: 'invalid_request', error_code: 'AR130003' })).toBe(
			t.ciba_errorRequestGone()
		);
		expect(message({ error: 'temporarily_unavailable' })).toBe(t.ciba_errorTryAgain());
		expect(message({ error: 'rate_limit_exceeded' })).toBe(t.ciba_errorTooManyAttempts());
		expect(message({ error: 'login_required' })).toBe(t.error_login_required());
		expect(message({ error: 'network_error' })).toBe(t.ciba_errorOutcomeUnknown());
		expect(message({ error: 'access_denied' })).toBe('fallback');
	});

	it.each(LOGIN_UI_LOCALES.filter((locale) => locale !== 'en') as Locales[])(
		'translates every approval outcome for %s',
		(locale) => {
			setLocale('en');
			const english = get(LL);
			setLocale(locale);
			const translated = get(LL);

			for (const key of NEW_KEYS) {
				expect(translated[key](), `${locale}.${key}`).not.toBe('');
				expect(translated[key](), `${locale}.${key}`).not.toBe(english[key]());
			}
		}
	);
});
