import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	combineEntryMethods,
	handleEmailFieldEnterKey,
	resolveEmailFieldEnter
} from './login-email-enter';

describe('resolveEmailFieldEnter', () => {
	it.each([
		['email code only', { emailCode: true, totp: false }, 'send_email_code'],
		['authenticator app only', { emailCode: false, totp: true }, 'start_totp'],
		['both', { emailCode: true, totp: true }, 'ignore'],
		['neither (passkey only, for example)', { emailCode: false, totp: false }, 'ignore']
	])('%s', (_name, methods, expected) => {
		expect(resolveEmailFieldEnter(methods)).toBe(expected);
	});
});

function key(overrides: Record<string, unknown> = {}) {
	return { key: 'Enter', preventDefault: vi.fn(), ...overrides };
}

describe('handleEmailFieldEnterKey', () => {
	it('leaves Enter alone when only the email code is offered (it submits as before)', () => {
		const event = key();
		const startTotp = vi.fn();
		expect(handleEmailFieldEnterKey(event, { emailCode: true, totp: false }, { startTotp })).toBe(
			'send_email_code'
		);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(startTotp).not.toHaveBeenCalled();
	});

	it('goes to the authenticator-app screen and stops the form submit when only that is offered', () => {
		const event = key();
		const startTotp = vi.fn();
		handleEmailFieldEnterKey(event, { emailCode: false, totp: true }, { startTotp });
		expect(startTotp).toHaveBeenCalledTimes(1);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});

	it.each([
		['both methods', { emailCode: true, totp: true }],
		['no method', { emailCode: false, totp: false }]
	])('does nothing but stop the form submit with %s', (_name, methods) => {
		const event = key();
		const startTotp = vi.fn();
		expect(handleEmailFieldEnterKey(event, methods, { startTotp })).toBe('ignore');
		expect(startTotp).not.toHaveBeenCalled();
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});

	it.each([
		['another key', { key: 'a' }],
		['an Enter that confirms an IME conversion', { isComposing: true }],
		['the IME process key code', { keyCode: 229 }]
	])('ignores %s', (_name, overrides) => {
		const event = key(overrides);
		const startTotp = vi.fn();
		expect(
			handleEmailFieldEnterKey(event, { emailCode: false, totp: true }, { startTotp })
		).toBeNull();
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(startTotp).not.toHaveBeenCalled();
	});
});

describe('combineEntryMethods', () => {
	const none = { emailCode: false, totp: false };
	const mail = { emailCode: true, totp: false };
	const totp = { emailCode: false, totp: true };

	it('is the classic sign-in alone when there is no runtime screen', () => {
		expect(combineEntryMethods(null, mail, false)).toEqual(mail);
		expect(combineEntryMethods(null, mail, true)).toEqual(mail);
	});

	it('is the runtime screen alone when the classic sign-in is not drawn', () => {
		expect(combineEntryMethods(totp, mail, false)).toEqual(totp);
		expect(combineEntryMethods(none, mail, false)).toEqual(none);
	});

	it('adds the two when both are drawn (a runtime screen with no authentication widgets adds nothing)', () => {
		expect(combineEntryMethods(none, mail, true)).toEqual(mail);
		expect(combineEntryMethods(totp, mail, true)).toEqual({ emailCode: true, totp: true });
		expect(combineEntryMethods(none, none, true)).toEqual(none);
	});
});

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

describe('wiring on the login page', () => {
	const page = read('../routes/login/+page.svelte');
	const runtimeScreen = read('./components/RuntimeScreen.svelte');
	const loginView = read('./views/LoginView.svelte');
	const shown = 'shownEntryMethods,';

	it('decides the email field Enter from the methods the page shows, for both layouts', () => {
		const start = page.indexOf('function handleEmailFieldEnter(');
		const decide = page.slice(start, page.indexOf('function handleKeyPress', start));
		expect(decide).toContain(shown);
		expect(decide).toContain('startTotp: () => void handleTotpStart()');
		const legacy = page.slice(page.indexOf('function handleKeyPress'));
		expect(legacy.slice(0, 250)).toContain('handleEmailFieldEnter(event)');
		const runtime = page.slice(page.indexOf('function handleRuntimeEmailKeydown'));
		expect(runtime.slice(0, 150)).toContain('handleEmailFieldEnter(event)');
	});

	it('never sends an email code from a form submit when the page does not offer it', () => {
		const start = page.indexOf('function handleEmailVerificationProtocolSubmit');
		const handler = page.slice(start, page.indexOf('function getRuntimeTarget', start));
		expect(handler).toMatch(/if \(!shownEntryMethods\.emailCode\) return;/);
		expect(handler).toContain('handleEmailCodeSend(');
	});

	it('takes the methods from what the runtime screen shows, together with the classic sign-in when it is drawn', () => {
		expect(page).toMatch(
			/combineEntryMethods\(\s*runtimeShownAuthMethods,\s*\{ emailCode: showRuntimeEmailCode, totp: showRuntimeTotp \},\s*!blockLegacyAuthLayout\s*\)/
		);
		expect(page).toContain('bind:runtimeShownAuthMethods');
		expect(loginView).toContain('bind:shownAuthMethods={runtimeShownAuthMethods}');
		expect(runtimeScreen).toContain('shownAuthMethods = $bindable(null)');
	});

	it('hands the key events of the runtime screen email fields to the page', () => {
		expect(runtimeScreen.match(/onkeydown=\{[^}]*onEmailKeydown/g)?.length).toBe(2);
		expect(loginView).toContain('onEmailKeydown');
		expect(page).toContain('onRuntimeEmailKeydown={handleRuntimeEmailKeydown}');
	});
});
