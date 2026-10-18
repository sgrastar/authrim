// @vitest-environment jsdom
import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { blocks, screenOf } from '$lib/storybook/fixtures';
import LoginView from './LoginView.svelte';
import ReauthView from './ReauthView.svelte';
import SignupView from './SignupView.svelte';

const MESSAGE = /Human verification is currently unavailable/i;
const DISMISS = { name: /dismiss/i };

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

const screen = screenOf([blocks.heading('Sign in'), blocks.passkey()], {}, 'login');
const runtimeProps = {
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
		fieldValues: {},
		methodAvailability: { passkey: true },
		methodLoading: {},
		destinationFieldDecisions: {},
		consentSelectedValues: {},
		consentReady: true,
		loading: false
	}
};

describe.each([
	[
		'LoginView',
		LoginView,
		{
			title: 'Sign in',
			legacyHeading: false,
			legacyMethods: false,
			humanVerification,
			methods: { passkey: true, any: true },
			...runtimeProps
		}
	],
	[
		'SignupView',
		SignupView,
		{
			title: 'Sign up',
			legacyHeading: false,
			legacyMethods: false,
			humanVerification,
			methods: { passkey: true, any: true },
			...runtimeProps
		}
	]
])('%s', (_name, ViewComponent, props) => {
	// LoginView and SignupView take the props this test passes; the union of both is not renderable.
	const View = ViewComponent as typeof LoginView;
	it('shows the unavailable notice, and it cannot be dismissed', () => {
		const { getByText, queryByRole } = render(View, {
			props: { ...props, alerts: { humanVerificationUnavailable: true } } as never
		});
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(queryByRole('button', DISMISS)).toBeNull();
	});

	it('shows it next to an ordinary error, which has its own dismiss button', () => {
		const { getByText, getAllByRole } = render(View, {
			props: {
				...props,
				alerts: { humanVerificationUnavailable: true, error: 'Something else failed' }
			} as never
		});
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(getByText('Something else failed')).toBeTruthy();
		// Only the ordinary error can be dismissed.
		expect(getAllByRole('button', DISMISS)).toHaveLength(1);
	});

	it('shows nothing about it by default', () => {
		const { queryByText } = render(View, {
			props: { ...props, alerts: { error: 'Something else failed' } } as never
		});
		expect(queryByText(MESSAGE)).toBeNull();
	});

	it('keeps an error that arrives later visible next to the notice', async () => {
		const { getByText, rerender } = render(View, {
			props: { ...props, alerts: { humanVerificationUnavailable: true, error: 'First' } } as never
		});
		await rerender({
			...props,
			alerts: { humanVerificationUnavailable: true, error: '' }
		} as never);
		await rerender({
			...props,
			alerts: { humanVerificationUnavailable: true, error: 'Second' }
		} as never);
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(getByText('Second')).toBeTruthy();
	});
});

describe('ReauthView', () => {
	it('shows the notice apart from the error, and keeps it when the error clears', async () => {
		const { getByText, queryByText, queryAllByRole, rerender } = render(ReauthView, {
			props: { humanVerificationUnavailable: true, error: 'Verification failed' }
		});
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(getByText('Verification failed')).toBeTruthy();
		expect(queryAllByRole('button', DISMISS)).toHaveLength(1);

		await rerender({ humanVerificationUnavailable: true, error: '' });
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(queryByText('Verification failed')).toBeNull();
		expect(queryAllByRole('button', DISMISS)).toHaveLength(0);
	});

	it('shows no notice by default', () => {
		const { queryByText } = render(ReauthView, { props: {} });
		expect(queryByText(MESSAGE)).toBeNull();
	});
});
