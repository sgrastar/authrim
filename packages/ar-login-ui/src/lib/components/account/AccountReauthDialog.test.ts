import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountReauthDialog from './AccountReauthDialog.svelte';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

const source = readFileSync(new URL('./AccountReauthDialog.svelte', import.meta.url), 'utf8');

function renderDialog(props: Partial<Parameters<typeof AccountReauthDialog>[1]> = {}): string {
	return render(AccountReauthDialog, {
		props: {
			open: true,
			onPasskey: () => undefined,
			onSendEmailCode: () => undefined,
			onVerifyEmailCode: () => undefined,
			onVerifyTotp: () => undefined,
			onClose: () => undefined,
			...props
		}
	}).body.replace(HYDRATION_MARKERS, '');
}

const all = { passkeyAvailable: true, emailCodeAvailable: true, totpAvailable: true };

/** The button whose label is `label`, as one opening tag plus its content. */
const button = (body: string, label: string) =>
	body.match(new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${label}`))?.[0] ?? '';

describe('AccountReauthDialog', () => {
	beforeEach(() => setLocale('en'));

	it('draws nothing while closed', () => {
		expect(renderDialog({ ...all, open: false })).toBe('');
	});

	it('is a labelled and described modal dialog', () => {
		const body = renderDialog(all);
		const dialog = body.match(/<div[^>]*role="dialog"[^>]*>/)?.[0] ?? '';

		expect(dialog).toContain('aria-modal="true"');
		const labelledBy = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
		const describedBy = dialog.match(/aria-describedby="([^"]+)"/)?.[1];
		expect(body).toMatch(new RegExp(`<h2 id="${labelledBy}"[^>]*>Re-authentication</h2>`));
		expect(body).toMatch(new RegExp(`<p id="${describedBy}"[^>]*>[^<]+</p>`));
	});

	it('closes from an icon button and a backdrop that is not a control', () => {
		const body = renderDialog(all);

		expect(body).toMatch(
			/<button[^>]*aria-label="Close"[^>]*>\s*<span class="i-ph-x[^"]*" aria-hidden="true">/
		);
		expect(body).toMatch(/<div class="reauth-backdrop[^"]*" aria-hidden="true">/);
		expect(body.match(/<button/g)).toHaveLength(5);
	});

	it('offers each available method', () => {
		const body = renderDialog(all);
		expect(body).toContain('Re-authenticate with Passkey');
		expect(body).toContain('Re-authenticate with email code');
		expect(body).toContain('Re-authenticate with authenticator app');

		const passkeyOnly = renderDialog({ passkeyAvailable: true });
		expect(passkeyOnly).toContain('Re-authenticate with Passkey');
		expect(passkeyOnly).not.toContain('email code');
		expect(passkeyOnly).not.toContain('authenticator app');
		expect(passkeyOnly).not.toContain('role="alert"');
	});

	it('says so when no method is available', () => {
		expect(renderDialog()).toMatch(
			/role="alert"[^>]*>No authentication method is available for re-authentication\./
		);
	});

	it('labels the code fields and names where the email code went', () => {
		const body = renderDialog({
			...all,
			emailCodeSent: true,
			maskedEmail: 'a***@example.com'
		});

		expect(body).toContain('A verification code was sent to a***@example.com.');
		expect(body).toMatch(
			/<label for="([^"]+)"[^>]*>Verification code<\/label>\s*<input[^>]*id="\1"[^>]*maxlength="6"/
		);
		expect(body).toMatch(
			/<label for="([^"]+)"[^>]*>Authenticator code<\/label>\s*<input[^>]*id="\1"[^>]*maxlength="8"/
		);
		expect(body).not.toContain('Re-authenticate with email code');
		expect(button(body, 'Verify code')).toContain('disabled');
	});

	it('enables verification once the code has the right length', () => {
		const body = renderDialog({
			...all,
			emailCodeSent: true,
			emailCode: '123456',
			totpCode: '12345678'
		});
		expect(button(body, 'Verify code')).not.toContain('disabled');
		expect(button(body, 'Re-authenticate with authenticator app')).not.toContain('disabled');

		expect(button(renderDialog({ ...all, totpCode: '1234567' }), 'authenticator app')).toContain(
			'disabled'
		);
	});

	it('spins the method in progress and makes the others wait', () => {
		const body = renderDialog({ ...all, pending: 'email' });

		expect(button(body, 'Re-authenticate with email code')).toContain('aria-busy="true"');
		expect(button(body, 'Re-authenticate with Passkey')).toMatch(/disabled[^>]*aria-busy="false"/);
		expect(button(body, 'Cancel')).not.toContain('disabled');
	});

	it('announces a failure', () => {
		expect(renderDialog({ ...all, error: 'The code is wrong.' })).toMatch(
			/role="alert"[^>]*>The code is wrong\./
		);
	});

	it('sits above the fixed page controls and traps focus while open', () => {
		expect(source).toContain('z-index: var(--z-modal-backdrop);');
		expect(source).toContain('z-index: var(--z-modal);');
		expect(source).not.toContain('!important');
		expect(source).toContain("event.key === 'Escape'");
		expect(source).toContain("event.key !== 'Tab'");
		expect(source).toContain('opener.focus()');
	});
});
