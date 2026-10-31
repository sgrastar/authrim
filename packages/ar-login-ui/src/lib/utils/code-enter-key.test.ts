import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleCodeEnterKey } from './code-enter-key';

function key(overrides: Record<string, unknown> = {}) {
	return { key: 'Enter', preventDefault: vi.fn(), ...overrides };
}

describe('handleCodeEnterKey', () => {
	it('submits the code and stops the implicit form submit on Enter', () => {
		const event = key();
		const submit = vi.fn();
		expect(handleCodeEnterKey(event, submit)).toBe(true);
		expect(submit).toHaveBeenCalledTimes(1);
		expect(event.preventDefault).toHaveBeenCalledTimes(1);
	});

	it('ignores other keys without touching them', () => {
		for (const overrides of [{ key: 'a' }, { key: 'Tab' }]) {
			const event = key(overrides);
			const submit = vi.fn();
			expect(handleCodeEnterKey(event, submit)).toBe(false);
			expect(submit).not.toHaveBeenCalled();
			expect(event.preventDefault).not.toHaveBeenCalled();
		}
	});

	it.each([
		['an Enter that confirms an IME conversion', { isComposing: true }],
		['the IME process key code', { keyCode: 229 }]
	])(
		'does not submit the code for %s, but still keeps the form from reacting to it',
		(_name, overrides) => {
			const event = key(overrides);
			const submit = vi.fn();
			expect(handleCodeEnterKey(event, submit)).toBe(false);
			expect(submit).not.toHaveBeenCalled();
			expect(event.preventDefault).toHaveBeenCalledTimes(1);
		}
	);
});

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

describe('wiring: the login form is not split by screen state', () => {
	const loginPage = read('../../routes/login/+page.svelte');
	const runtimeScreen = read('../components/RuntimeScreen.svelte');
	const pinInput = read('../components/PinCodeInput.svelte');
	const loginView = read('../views/LoginView.svelte');

	it('keeps the form submit handler sending the email code, whatever the screen state', () => {
		const start = loginPage.indexOf('function handleEmailVerificationProtocolSubmit');
		const handler = loginPage.slice(start, loginPage.indexOf('function getRuntimeTarget', start));
		expect(handler).toContain('handleEmailCodeSend(');
		expect(handler).not.toContain('handleTotpVerify');
		expect(handler).not.toContain('handleMailOtpInlineVerify');
		expect(handler).not.toContain('totpCodeRequested');
		expect(handler).not.toContain('mailOtpSent');
	});

	it('lets the code field itself take Enter, only when the screen asks for it', () => {
		expect(pinInput).toContain('onkeydown');
		expect(pinInput).toContain('handleCodeEnterKey');
		expect(runtimeScreen).toContain('verifyCodeOnEnter');
		expect(runtimeScreen).toMatch(
			/onEnter=\{\s*verifyCodeOnEnter \? \(\) => verifyCodeFromKeyboard\(method\)/
		);
		expect(runtimeScreen).toMatch(/function verifyCodeFromKeyboard[\s\S]*?'verify_code'/);
		expect(loginView).toContain('verifyCodeOnEnter');
	});

	it('stops the implicit submit on Enter in the legacy authenticator-app field', () => {
		const start = loginPage.indexOf('function handleTotpKeyPress');
		const handler = loginPage.slice(
			start,
			loginPage.indexOf('function handleRuntimeScreen', start)
		);
		expect(handler).toContain('handleCodeEnterKey(event');
	});

	it('activates the authenticator app on Enter in the signup activation code field', () => {
		const signupView = read('../views/SignupView.svelte');
		expect(signupView).toContain('onkeypress={handleTotpActivateKeyPress}');
		expect(signupView).toMatch(
			/function handleTotpActivateKeyPress[\s\S]*?handleCodeEnterKey\(event/
		);
		expect(signupView).toMatch(/handleCodeEnterKey\(event[\s\S]*?onTotpActivate\?\.\(\)/);
	});
});
