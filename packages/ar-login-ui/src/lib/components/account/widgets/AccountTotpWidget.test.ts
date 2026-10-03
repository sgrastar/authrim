import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import type { AccountTotpCredential } from '$lib/api/account';
import AccountTotpWidget from './AccountTotpWidget.svelte';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

const handlers = {
	onStartEnrollment: (_label: string) => undefined,
	onActivateEnrollment: (_code: string) => undefined,
	onDeleteCredential: (_id: string, _code: string) => undefined,
	onRegenerateBackupCodes: (_code: string) => undefined,
	onClearEnrollment: () => undefined
};

const credential: AccountTotpCredential = {
	id: 'totp-1',
	label: 'Phone',
	algorithm: 'SHA1',
	digits: 6,
	period: 30,
	window: 1,
	status: 'active',
	created_at: Date.UTC(2026, 7, 9, 10, 30),
	activated_at: Date.UTC(2026, 7, 9, 10, 31),
	last_used_at: null
};

const enrollment = {
	credentialId: 'totp-2',
	secret: 'JBSWY3DPEHPK3PXP',
	otpauthUri: 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP',
	backupCodes: []
};

/** Every <input id> must have a <label for> naming it. */
function unlabelledInputs(body: string): string[] {
	const labelled = new Set([...body.matchAll(/<label for="([^"]+)"/g)].map((match) => match[1]));
	return [...body.matchAll(/<input[^>]*\sid="([^"]+)"/g)]
		.map((match) => match[1])
		.filter((id) => !labelled.has(id));
}

describe('AccountTotpWidget', () => {
	it('labels the activation, regenerate and delete-proof inputs', () => {
		setLocale('en');
		const body = render(AccountTotpWidget, {
			props: {
				...handlers,
				managementEnabled: true,
				credentials: [credential],
				backupCodes: { total: 10, remaining: 8 },
				enrollment
			}
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('Authenticator code');
		expect(body).toContain('Current code');
		expect(body).toContain('Phone: Current code or backup code');
		expect(body).toContain('8 of 10 backup codes remaining');
		expect([...body.matchAll(/<input/g)]).toHaveLength(4);
		expect(unlabelledInputs(body)).toEqual([]);
	});

	it('puts the setup heading one level below the widget heading', () => {
		setLocale('en');
		const own = render(AccountTotpWidget, { props: { ...handlers, enrollment } }).body.replace(
			HYDRATION_MARKERS,
			''
		);
		const nested = render(AccountTotpWidget, {
			props: { ...handlers, enrollment, headingLevel: 3 }
		}).body.replace(HYDRATION_MARKERS, '');

		expect(own).toMatch(/<h2[^>]*>Authenticator apps<\/h2>/);
		expect(own).toMatch(/<h3[^>]*>Set up authenticator app<\/h3>/);
		expect(nested).toMatch(/<h3[^>]*>Authenticator apps<\/h3>/);
		expect(nested).toMatch(/<h4[^>]*>Set up authenticator app<\/h4>/);
	});

	it('shows the one-time backup codes once the enrollment is activated', () => {
		setLocale('en');
		const body = render(AccountTotpWidget, {
			props: { ...handlers, enrollment: { ...enrollment, backupCodes: ['ABCD1234EFGH'] } }
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('Backup codes');
		expect(body).toContain('ABCD1234EFGH');
		expect(body).toContain('Done');
	});

	it('draws nothing inside a parent panel when there is nothing to manage', () => {
		setLocale('en');
		const nested = render(AccountTotpWidget, {
			props: { ...handlers, headingLevel: 3 }
		}).body.replace(HYDRATION_MARKERS, '');
		const own = render(AccountTotpWidget, { props: { ...handlers } }).body.replace(
			HYDRATION_MARKERS,
			''
		);

		expect(nested).not.toContain('Authenticator apps');
		expect(own).toContain('Authenticator apps');
	});

	it('shows a skeleton while loading', () => {
		setLocale('en');
		const body = render(AccountTotpWidget, {
			props: { ...handlers, headingLevel: 3, loading: true }
		}).body.replace(HYDRATION_MARKERS, '');

		expect(body).toContain('account-section-skeleton');
		expect(body).not.toContain('No items');
	});
});
