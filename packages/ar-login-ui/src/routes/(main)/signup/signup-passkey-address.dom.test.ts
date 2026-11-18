// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	flowStart: vi.fn(),
	registerOptions: vi.fn(),
	validateInvitation: vi.fn(),
	sendEmailCode: vi.fn(),
	page: { url: new URL('https://tenant.example.test/signup'), params: {}, data: {} }
}));

vi.mock('$app/state', () => ({ page: mocks.page }));
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
		passkeyAPI: { ...actual.passkeyAPI, getRegisterOptions: mocks.registerOptions },
		invitationAPI: {
			...actual.invitationAPI,
			validate: mocks.validateInvitation,
			sendEmailCode: mocks.sendEmailCode
		}
	};
});

import Harness from '#lib/testing/SignupPageHarness.svelte';

function methodsResponse() {
	return {
		methods: {
			passkey: { enabled: true, signupEnabled: true, capabilities: [] },
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

const open = (query = '') => {
	mocks.page.url = new URL(`https://tenant.example.test/signup${query}`);
	// The page reads its parameters from the address bar.
	window.history.replaceState({}, '', `/signup${query}`);
	return render(Harness, { props: { data: { authenticationMethods: methodsResponse() } } });
};
const PASSKEY = { name: /passkey/i };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.flowStart.mockResolvedValue({ data: null, error: null });
	// The start is refused here: the page never reaches the browser's passkey prompt.
	mocks.registerOptions.mockResolvedValue({ data: null, error: { error: 'stop' } });
	mocks.sendEmailCode.mockResolvedValue({ data: null, error: { error: 'stop' } });
	Object.defineProperty(window, 'PublicKeyCredential', {
		configurable: true,
		value: { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) }
	});
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

describe("the signup page's passkey", () => {
	it('is offered to an ordinary signup and sends no address, even a prefilled one', async () => {
		const { findByRole } = open('?email=typed%40example.test');

		await fireEvent.click(await findByRole('button', PASSKEY));
		await waitFor(() => expect(mocks.registerOptions).toHaveBeenCalledOnce());
		const sent = mocks.registerOptions.mock.calls[0][0];
		expect(new URLSearchParams(window.location.search).get('email')).toBe('typed@example.test');
		expect(sent.email).toBeUndefined();
		expect(sent.inviteToken).toBeUndefined();
	});

	it('is not offered with an invitation that asks no proof of its address', async () => {
		mocks.validateInvitation.mockResolvedValue({
			data: { email_verification_required: false, invited_email: 'invited@example.test' },
			error: null
		});
		const { queryByRole } = open('?invite_token=invite-1');

		await waitFor(() => expect(mocks.validateInvitation).toHaveBeenCalledOnce());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(queryByRole('button', PASSKEY)).toBeNull();
		expect(mocks.registerOptions).not.toHaveBeenCalled();
	});

	it('is held for the proof when the invitation asks for it, and sends nothing before', async () => {
		mocks.validateInvitation.mockResolvedValue({
			data: { email_verification_required: true, invited_email: 'invited@example.test' },
			error: null
		});
		const { findByRole } = open('?invite_token=invite-1');

		await fireEvent.click(await findByRole('button', PASSKEY));
		await waitFor(() => expect(mocks.sendEmailCode).toHaveBeenCalledWith('invite-1'));
		expect(mocks.registerOptions).not.toHaveBeenCalled();
	});
});
