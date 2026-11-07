// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ flowStart: vi.fn(), externalStart: vi.fn() }));

vi.mock('$app/state', () => ({
	page: { url: new URL('https://tenant.example.test/signup'), params: {}, data: {} }
}));
vi.mock('#lib/api/flow-runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/flow-runtime.js')>();
	return {
		...actual,
		flowRuntimeAPI: {
			start: mocks.flowStart,
			submit: vi.fn(),
			createEmailVerificationChallenge: vi.fn()
		}
	};
});
vi.mock('#lib/api/client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/client.js')>();
	return {
		...actual,
		externalIdpAPI: { ...actual.externalIdpAPI, startLogin: mocks.externalStart }
	};
});

import Harness from '#lib/testing/SignupPageHarness.svelte';

const provider = (id: string, name: string, loginEnabled: boolean, signupEnabled: boolean) => ({
	id,
	name,
	type: 'oidc',
	startMode: 'oauth_redirect',
	enabled: true,
	loginEnabled,
	signupEnabled,
	reauthEnabled: loginEnabled,
	accountLinkEnabled: true,
	startUrl: `/api/external/${id}/start`
});

function methodsResponse() {
	return {
		methods: {
			passkey: { enabled: false, signupEnabled: false, capabilities: [] },
			emailCode: { enabled: false, signupEnabled: false, digits: 6, steps: [] },
			totp: { enabled: false, signupEnabled: false, digits: 6, steps: [] },
			directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
			humanVerification: {
				enabled: false,
				provider: 'turnstile',
				siteKey: null,
				loginEnabled: false,
				signupEnabled: false,
				reauthEnabled: false,
				failurePolicy: 'fail_closed',
				widget: { actionPrefix: 'authrim', theme: 'auto', size: 'flexible', mode: 'managed' }
			},
			external: {
				enabled: true,
				providers: [
					provider('signup-only', 'Signup Only IdP', false, true),
					provider('login-only', 'Login Only IdP', true, false),
					provider('both', 'Both IdP', true, true)
				]
			}
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
	// The start is refused here so the page stays put (no navigation in jsdom).
	mocks.externalStart.mockRejectedValue(new Error('stop'));
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

describe("the signup page's external providers", () => {
	it('lists the providers the tenant lets sign people up, and starts them as a sign-up', async () => {
		const { findByRole, queryByRole } = render(Harness, {
			props: { data: { authenticationMethods: methodsResponse() } }
		});

		const signupOnly = await findByRole('button', { name: /Signup Only IdP/ });
		expect(await findByRole('button', { name: /Both IdP/ })).toBeTruthy();
		expect(queryByRole('button', { name: /Login Only IdP/ })).toBeNull();

		await fireEvent.click(signupOnly);
		await waitFor(() => expect(mocks.externalStart).toHaveBeenCalledOnce());
		const args = mocks.externalStart.mock.calls[0];
		expect(args[0]).toBe('signup-only');
		expect(args[8]).toBe('signup');
	});
});
