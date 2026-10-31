// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ReauthView from './ReauthView.svelte';
import SignupView from './SignupView.svelte';

const humanVerification = {
	siteKey: null,
	provider: 'turnstile' as const,
	mode: 'managed' as const,
	action: 'authrim-login',
	theme: 'light' as const,
	language: 'en',
	resetKey: 0,
	runtimeRequired: false,
	runtimeVisible: false
};

describe('Enter in the authenticator-app code field of the other screens (real DOM)', () => {
	it('/reauth: Enter reaches the page handler, and the screen has no form to submit', async () => {
		const onTotpKeyPress = vi.fn();
		const user = userEvent.setup();
		const { container } = render(ReauthView, {
			props: { totpEnabled: true, totpCodeRequested: true, totpCode: '123456', onTotpKeyPress }
		});
		expect(container.querySelector('form')).toBeNull();
		const code = container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
		await user.click(code);
		await user.keyboard('{Enter}');
		expect(onTotpKeyPress).toHaveBeenCalledTimes(1);
		expect((onTotpKeyPress.mock.calls[0][0] as KeyboardEvent).key).toBe('Enter');
	});

	it('/signup: Enter in the activation code activates the authenticator app and does not submit the form', async () => {
		const onTotpActivate = vi.fn();
		const onSubmit = vi.fn((event: SubmitEvent) => event.preventDefault());
		const user = userEvent.setup();
		const { container } = render(SignupView, {
			props: {
				title: 'Sign up',
				humanVerification,
				methods: { totp: true, any: true },
				totpSetup: { secret: 'SECRET', qrDataUrl: '', backupCodes: [] },
				totpCode: '123456',
				onTotpActivate,
				onSubmit
			}
		});
		const code = container.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
		expect(code).not.toBeNull();
		await user.click(code);
		await user.keyboard('{Enter}');
		expect(onTotpActivate).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
