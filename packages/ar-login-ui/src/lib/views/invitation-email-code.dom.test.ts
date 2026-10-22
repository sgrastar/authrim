// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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

function renderStep(props: Record<string, unknown> = {}) {
	const handlers = {
		onInvitationCodeVerify: vi.fn(),
		onInvitationCodeResend: vi.fn(),
		onInvitationCodeCancel: vi.fn(),
		onPasskey: vi.fn(),
		onSubmit: vi.fn((event: SubmitEvent) => event.preventDefault())
	};
	const view = render(SignupView, {
		props: {
			title: 'Sign up',
			humanVerification,
			methods: { passkey: true, emailCode: true, totp: true, any: true },
			invitationEmailCode: { maskedEmail: 'i***@example.com' },
			...handlers,
			...props
		}
	});
	return { ...view, handlers };
}

describe('the code step an invitation asks of a passkey or authenticator-app signup (real DOM)', () => {
	it('shows the masked invited email and holds the signup methods back while it is open', () => {
		const { container, getByTestId } = renderStep();

		expect(getByTestId('invitation-email-code').textContent).toContain('i***@example.com');
		expect(container.querySelector('.i-ph-key')).toBeNull();
		expect(container.querySelector('.i-ph-device-mobile')).toBeNull();
	});

	it('shows the step, and holds the runtime screen back, when a runtime screen draws the methods', () => {
		const { getByTestId, container } = renderStep({
			legacyMethods: false,
			legacyHeading: false,
			runtimeStep: {
				component: 'registration',
				isAuthStep: true,
				screen: null,
				title: 'Create your account',
				description: '',
				consentPolicy: null,
				destinationFieldConsent: null
			}
		});

		expect(getByTestId('invitation-email-code').textContent).toContain('i***@example.com');
		expect(container.textContent).not.toContain('Create your account');
	});

	it('shows the signup methods again once the step is closed', () => {
		const { container, queryByTestId } = renderStep({ invitationEmailCode: null });

		expect(queryByTestId('invitation-email-code')).toBeNull();
		expect(container.querySelector('.i-ph-key')).not.toBeNull();
	});

	it('verifies on Enter with a full code, without submitting the signup form', async () => {
		const user = userEvent.setup();
		const { container, handlers } = renderStep();
		const code = container.querySelector(
			'[data-testid="invitation-email-code"] input'
		) as HTMLInputElement;

		await user.click(code);
		await user.keyboard('12345{Enter}');
		expect(handlers.onInvitationCodeVerify).not.toHaveBeenCalled();

		await user.keyboard('6{Enter}');
		expect(handlers.onInvitationCodeVerify).toHaveBeenCalledTimes(1);
		expect(handlers.onSubmit).not.toHaveBeenCalled();
	});

	it('shows why a code was refused, and sends again or closes on request', async () => {
		const user = userEvent.setup();
		const { getByTestId, getByText, handlers } = renderStep({
			invitationEmailCode: { maskedEmail: 'i***@example.com', error: 'Invalid or expired code' }
		});

		expect(getByTestId('invitation-email-code').textContent).toContain('Invalid or expired code');
		await user.click(getByText('Resend code'));
		await user.click(getByText('Cancel'));
		expect(handlers.onInvitationCodeResend).toHaveBeenCalledTimes(1);
		expect(handlers.onInvitationCodeCancel).toHaveBeenCalledTimes(1);
	});
});
