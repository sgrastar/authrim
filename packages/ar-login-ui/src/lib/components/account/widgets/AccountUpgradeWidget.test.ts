import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountUpgradeWidget from './AccountUpgradeWidget.svelte';
import { guestUpgradeStatus } from './fixtures';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

function renderUpgrade(props: Partial<Parameters<typeof AccountUpgradeWidget>[1]> = {}) {
	return render(AccountUpgradeWidget, {
		props: {
			status: guestUpgradeStatus(),
			onStartEmail: () => undefined,
			onStartPasskey: () => undefined,
			onConfirmCode: () => undefined,
			onChangeMethod: () => undefined,
			onRetry: () => undefined,
			...props
		}
	}).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountUpgradeWidget', () => {
	it('formats the deletion deadline in the UI language', () => {
		const due = guestUpgradeStatus().deletion_due_at as number;
		setLocale('de');
		expect(renderUpgrade()).toContain(new Date(due * 1000).toLocaleString('de'));
		setLocale('ja');
		expect(renderUpgrade()).toContain(new Date(due * 1000).toLocaleString('ja'));
	});

	it('offers each allowed method with a labelled email field', () => {
		setLocale('en');
		const body = renderUpgrade();

		expect(body).toMatch(/<label for="([^"]+)"[^>]*>\s*Email address\s*<\/label>[\s\S]*id="\1"/);
		expect(body).toContain('Register with email');
		expect(body).toContain('Register with a passkey');
	});

	it('asks for the confirmation code once the email attempt started', () => {
		setLocale('en');
		const body = renderUpgrade({ attemptMethod: 'email' });

		expect(body).toContain('Confirmation code');
		expect(body).toContain('Confirm registration');
		expect(body).toContain('Choose another method');
		// A literal pattern: `pattern="[0-9]{6}"` would interpolate to "[0-9]6" and block every code.
		expect(body).toContain('pattern="[0-9]{6}"');
		expect(body).not.toContain('Register with email');
	});

	it('reports a pending registration with a retry instead of the methods', () => {
		setLocale('en');
		const body = renderUpgrade({ pending: true });

		expect(body).toMatch(/role="status"[^>]*>Registration is in progress/);
		expect(body).toContain('Retry');
		expect(body).not.toContain('Register with email');
	});

	it('offers signing in to the existing account only with a handler', () => {
		setLocale('en');
		expect(renderUpgrade({ collision: true, onExistingLogin: () => undefined })).toContain(
			'Sign in to an existing account'
		);
		const body = renderUpgrade({ collision: true });
		expect(body).toMatch(/role="alert"/);
		expect(body).not.toContain('Sign in to an existing account');
	});

	it('shows the outcome alone once completed, and nothing for a registered account', () => {
		setLocale('en');
		expect(renderUpgrade({ completed: true })).toMatch(
			/role="status"[^>]*>Your account has been registered\./
		);
		expect(
			renderUpgrade({ status: guestUpgradeStatus({ registration_state: 'registered' }) })
		).not.toContain('Register');
	});
});
