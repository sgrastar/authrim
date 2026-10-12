// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { blocks, screenOf } from '$lib/storybook/fixtures';
import LoginView from './LoginView.svelte';

// The real LoginView -> RuntimeScreen -> PinCodeInput in a DOM, with real key presses.
const screen = screenOf([blocks.heading('Sign in'), blocks.passkey(), blocks.totp()], {}, 'login');

function mountLoginView(fieldValues: Record<string, string>) {
	const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
	const onRuntimeAuthAction = vi.fn();
	const result = render(LoginView, {
		props: {
			title: 'Sign in',
			legacyHeading: false,
			legacyMethods: false,
			humanVerification: {
				siteKey: null,
				provider: 'turnstile',
				mode: 'managed',
				action: 'authrim-login',
				theme: 'light',
				language: 'en',
				resetKey: 0,
				runtimeRequired: false,
				runtimeVisible: false
			},
			methods: { passkey: true, totp: true, any: true },
			runtimeStep: {
				component: 'login',
				isAuthStep: true,
				screen,
				title: 'Sign in',
				description: '',
				consentPolicy: null,
				destinationFieldConsent: null
			},
			runtime: {
				fieldValues,
				methodAvailability: { passkey: true, totp: true },
				methodLoading: {},
				destinationFieldDecisions: {},
				consentSelectedValues: {},
				consentReady: true,
				loading: false
			},
			onSubmit,
			onRuntimeAuthAction
		}
	});
	return { ...result, onSubmit, onRuntimeAuthAction };
}

describe('Enter in the authenticator-app code field (real DOM)', () => {
	it('verifies the code and does not submit the form', async () => {
		const user = userEvent.setup();
		const { container, onSubmit, onRuntimeAuthAction } = mountLoginView({
			totp_code_requested: 'true',
			code_input_method: 'totp',
			totp_code: '123456'
		});
		const pin = container.querySelector('.pin-code-input__native') as HTMLInputElement;
		expect(pin).not.toBeNull();

		await user.click(pin);
		await user.keyboard('{Enter}');

		expect(onRuntimeAuthAction).toHaveBeenCalledWith('totp', 'verify_code');
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it('an Enter that confirms an IME conversion verifies nothing, and the form does not react to it either', async () => {
		const user = userEvent.setup();
		const { container, onSubmit, onRuntimeAuthAction } = mountLoginView({
			totp_code_requested: 'true',
			code_input_method: 'totp',
			totp_code: '123456'
		});
		const pin = container.querySelector('.pin-code-input__native') as HTMLInputElement;
		await user.click(pin);

		const event = new KeyboardEvent('keydown', {
			key: 'Enter',
			isComposing: true,
			bubbles: true,
			cancelable: true
		});
		pin.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(onRuntimeAuthAction).not.toHaveBeenCalled();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
