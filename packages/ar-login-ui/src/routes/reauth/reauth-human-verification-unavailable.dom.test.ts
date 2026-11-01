// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getData: vi.fn(), fetchMethods: vi.fn() }));

vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://tenant.example.test/reauth?challenge_id=challenge-1'),
		params: {},
		data: {}
	}
}));
vi.mock('$lib/api/client', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/client')>();
	return { ...actual, loginChallengeAPI: { ...actual.loginChallengeAPI, getData: mocks.getData } };
});
vi.mock('$lib/api/authentication-methods', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/authentication-methods')>();
	return { ...actual, fetchAuthenticationMethods: mocks.fetchMethods };
});

import Harness from '$lib/testing/ReauthPageHarness.svelte';

const MESSAGE = /Human verification is currently unavailable/i;

function methods(humanVerification: Record<string, unknown>) {
	return {
		data: {
			methods: {
				passkey: { enabled: true, reauthEnabled: true, capabilities: [] },
				emailCode: { enabled: true, reauthEnabled: true, digits: 6, steps: [] },
				totp: { enabled: false, digits: 6, steps: [] },
				directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
				humanVerification: {
					enabled: false,
					provider: 'turnstile',
					siteKey: null,
					loginEnabled: false,
					signupEnabled: false,
					reauthEnabled: false,
					failurePolicy: 'fail_closed',
					widget: { actionPrefix: 'authrim', theme: 'auto', size: 'flexible', mode: 'managed' },
					...humanVerification
				},
				external: { enabled: false, providers: [] }
			}
		},
		error: null
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		onchange: null,
		dispatchEvent: () => false
	})) as typeof window.matchMedia;
});

describe('the reauth page when the tenant requires human verification the provider cannot serve', () => {
	const unavailable = {
		requiredFor: { login: false, signup: false, reauth: true },
		available: false,
		reason: 'provider_disabled'
	};

	it('says so, and keeps saying so next to a failure of its own', async () => {
		mocks.getData.mockResolvedValue({ data: null, error: { error: 'server_error' } });
		mocks.fetchMethods.mockResolvedValue(methods(unavailable));
		const { findByText, getByText } = render(Harness);
		expect(await findByText(MESSAGE)).toBeTruthy();
		await waitFor(() => expect(mocks.getData).toHaveBeenCalled());
		// The challenge failed to load: that error and the notice are both on the page.
		expect(getByText(MESSAGE)).toBeTruthy();
		expect(document.body.textContent).toMatch(/error|failed|try again/i);
	});

	it('shows no notice when the provider is available', async () => {
		mocks.getData.mockResolvedValue({ data: { user: { email: 'u@example.com' } }, error: null });
		mocks.fetchMethods.mockResolvedValue(
			methods({ ...unavailable, available: true, reason: null })
		);
		const { queryByText } = render(Harness);
		await waitFor(() => expect(mocks.fetchMethods).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(queryByText(MESSAGE)).toBeNull();
	});
});
