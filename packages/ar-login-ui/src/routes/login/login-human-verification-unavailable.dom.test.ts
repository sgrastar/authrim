// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ flowStart: vi.fn() }));

vi.mock('$app/state', () => ({
	page: { url: new URL('https://tenant.example.test/login'), params: {}, data: {} }
}));
vi.mock('$lib/api/flow-runtime', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/api/flow-runtime')>();
	return {
		...actual,
		flowRuntimeAPI: {
			start: mocks.flowStart,
			submit: vi.fn(),
			createEmailVerificationChallenge: vi.fn()
		}
	};
});

import Harness from '$lib/testing/LoginPageHarness.svelte';

const MESSAGE = /Human verification is currently unavailable/i;

function methodsResponse(humanVerification: Record<string, unknown>) {
	return {
		methods: {
			passkey: { enabled: true, loginEnabled: true, capabilities: [] },
			emailCode: { enabled: false, loginEnabled: false, digits: 6, steps: [] },
			totp: { enabled: false, loginEnabled: false, digits: 6, steps: [] },
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
		},
		ui: {
			theme: 'default',
			branding: { logoUrl: null, brandName: 'Authrim' },
			supportedLocales: ['en', 'ja'],
			selfService: { accountPageEnabled: true, accountPagePath: '/account' }
		},
		meta: { cacheTTL: 180, revision: 'test' }
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flowStart.mockResolvedValue({ data: null, error: null });
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

describe('the login page when the tenant requires human verification the provider cannot serve', () => {
	it.each(['provider_disabled', 'provider_unconfigured', 'settings_unreadable'])(
		'says so instead of failing silently (%s)',
		async (reason) => {
			const { findByText } = render(Harness, {
				props: {
					data: {
						authenticationMethods: methodsResponse({
							requiredFor: { login: true, signup: false, reauth: false },
							available: false,
							reason
						})
					}
				}
			});
			expect(await findByText(MESSAGE)).toBeTruthy();
		}
	);

	it.each([
		[
			'the provider is available',
			{ requiredFor: { login: true, signup: false, reauth: false }, available: true, reason: null }
		],
		[
			'only another flow requires it',
			{
				requiredFor: { login: false, signup: true, reauth: true },
				available: false,
				reason: 'provider_disabled'
			}
		],
		['an older server sends no such fields', {}]
	])('shows no such message when %s', async (_name, humanVerification) => {
		const { queryByText } = render(Harness, {
			props: { data: { authenticationMethods: methodsResponse(humanVerification) } }
		});
		await waitFor(() => expect(mocks.flowStart).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(queryByText(MESSAGE)).toBeNull();
	});
});
