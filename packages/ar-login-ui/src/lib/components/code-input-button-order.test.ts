import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// On a code entry screen the main action (verify the code) comes first and the way back after
// it. The Tab order follows the source order, so this fixes both what is seen and the focus order.
const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');

function indexOfIn(source: string, needle: string, from = 0): number {
	const index = source.indexOf(needle, from);
	expect(index, `${needle} is missing`).toBeGreaterThan(-1);
	return index;
}

describe('the runtime code input screen (authenticator app and email code)', () => {
	const source = read('./RuntimeScreen.svelte');
	const start = indexOfIn(source, "blockType === 'code_input_widget'");
	const block = source.slice(start, indexOfIn(source, "blockType === 'guest_login_widget'", start));

	it('puts the verify button before the back button, for both methods', () => {
		const verify = indexOfIn(block, "onAuthAction?.(method, 'verify_code')");
		const back = block.indexOf("onAuthAction?.(method, 'back')");
		const lastBack = block.lastIndexOf("onAuthAction?.(method, 'back')");
		expect(back).toBeGreaterThan(verify);
		// The email code screen also has the back button in its actions row, and a second one
		// serves the authenticator app: both come after verify.
		expect(lastBack).toBeGreaterThan(verify);
	});

	it('keeps resend with the way back, after verify', () => {
		const verify = indexOfIn(block, "onAuthAction?.(method, 'verify_code')");
		expect(indexOfIn(block, "onAuthAction?.(method, 'resend_mail_otp')")).toBeGreaterThan(verify);
	});

	it('keeps the progress bar of the email code above the buttons', () => {
		expect(indexOfIn(block, 'runtime-code-progress')).toBeLessThan(
			indexOfIn(block, "onAuthAction?.(method, 'verify_code')")
		);
	});
});

describe('the legacy authenticator app code screen', () => {
	const source = read('../views/LoginView.svelte');
	const start = indexOfIn(source, '<!-- TOTP -->');
	const block = source.slice(start, indexOfIn(source, '<!-- External Login Section -->', start));

	it('puts the verify button before the back button', () => {
		const verify = indexOfIn(block, 'onclick={totpCodeRequested ? onTotpVerify : onTotpStart}');
		expect(indexOfIn(block, 'onTotpBack?.()')).toBeGreaterThan(verify);
	});
});
