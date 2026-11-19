// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	methods: vi.fn(),
	flowStart: vi.fn(),
	page: { url: new URL('https://tenant.example.test/login'), params: {}, data: {} }
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
vi.mock('#lib/api/authentication-methods.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/api/authentication-methods.js')>();
	return {
		...actual,
		fetchAuthenticationMethods: mocks.methods,
		fetchAuthenticationMethodsForClient: mocks.methods
	};
});

import LoginHarness from '#lib/testing/LoginPageHarness.svelte';
import SignupHarness from '#lib/testing/SignupPageHarness.svelte';

const HOST = window.location.hostname;
const GONE = /no longer available/i;
const STORAGE_KEY = 'authrim:passkey-user-handles';

function tenantStatus(body: unknown) {
	const fetcher = vi.fn(async (input: RequestInfo | URL) => {
		if (String(input) === '/api/auth/tenant-status') {
			return { ok: true, json: async () => body } as Response;
		}
		return { ok: false, status: 404, json: async () => ({}) } as Response;
	});
	vi.stubGlobal('fetch', fetcher);
	return fetcher;
}

function signalApi() {
	const api = {
		signalAllAcceptedCredentials: vi.fn().mockResolvedValue(undefined),
		signalUnknownCredential: vi.fn().mockResolvedValue(undefined)
	};
	Object.defineProperty(window, 'PublicKeyCredential', {
		value: api,
		configurable: true,
		writable: true
	});
	return api;
}

beforeEach(() => {
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

const statusCalls = (fetcher: ReturnType<typeof tenantStatus>) =>
	fetcher.mock.calls.filter(([input]) => String(input) === '/api/auth/tenant-status');

const pages = [
	['login', LoginHarness],
	['signup', SignupHarness]
] as const;

describe.each(pages)('the %s page on the host of a deleted tenant', (path, Harness) => {
	const open = () => {
		mocks.page.url = new URL(`https://tenant.example.test/${path}`);
		window.history.replaceState({}, '', `/${path}`);
		return render(Harness, { props: { data: { authenticationMethods: null } } });
	};

	beforeEach(() => {
		window.localStorage.clear();
		mocks.flowStart.mockReset().mockResolvedValue({ data: null, error: { error: 'not_found' } });
		mocks.methods
			.mockReset()
			.mockResolvedValue({ data: null, error: { error: 'not_found', error_description: '' } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		Object.defineProperty(window, 'PublicKeyCredential', {
			value: undefined,
			configurable: true,
			writable: true
		});
	});

	it('says the page is gone and reports the remembered passkey owners without asking', async () => {
		const api = signalApi();
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['dXNlci0x']));
		tenantStatus({ status: 'deleted', host: HOST });

		const view = open();

		await waitFor(() => expect(view.getByText(GONE)).toBeTruthy());
		await waitFor(() =>
			expect(api.signalAllAcceptedCredentials).toHaveBeenCalledWith({
				rpId: HOST,
				userId: 'dXNlci0x',
				allAcceptedCredentialIds: []
			})
		);
		// Kept: the provider gives no answer, so a later visit reports them again.
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(['dXNlci0x']));
		expect(view.getByRole('button', { name: /remove a saved passkey/i })).toBeTruthy();
	});

	it('reports the passkey the person picks', async () => {
		const api = signalApi();
		const get = vi.fn().mockResolvedValue({
			type: 'public-key',
			id: 'Y3JlZGVudGlhbC0x',
			response: { userHandle: new TextEncoder().encode('user-1').buffer }
		});
		Object.defineProperty(navigator, 'credentials', {
			value: { get },
			configurable: true,
			writable: true
		});
		tenantStatus({ status: 'deleted', host: HOST });

		const view = open();
		const button = await waitFor(() =>
			view.getByRole('button', { name: /remove a saved passkey/i })
		);
		expect(api.signalAllAcceptedCredentials).not.toHaveBeenCalled();
		await fireEvent.click(button);

		await waitFor(() =>
			expect(api.signalUnknownCredential).toHaveBeenCalledWith({
				rpId: HOST,
				credentialId: 'Y3JlZGVudGlhbC0x'
			})
		);
		expect(get.mock.calls[0][0].publicKey.rpId).toBe(HOST);
	});

	it('offers no button where the browser cannot report passkeys', async () => {
		tenantStatus({ status: 'deleted', host: HOST });

		const view = open();

		await waitFor(() => expect(view.getByText(GONE)).toBeTruthy());
		expect(view.queryByRole('button', { name: /remove a saved passkey/i })).toBeNull();
	});

	it.each([
		['the tenant is only unavailable', { status: 'unavailable' }],
		['the answer is about another host', { status: 'deleted', host: 'gone.example.com' }]
	])('keeps the ordinary page and reports nothing when %s', async (_name, body) => {
		const api = signalApi();
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['dXNlci0x']));
		const fetcher = tenantStatus(body);

		const view = open();

		await waitFor(() => expect(statusCalls(fetcher)).toHaveLength(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(view.queryByText(GONE)).toBeNull();
		// The page's own message for the failed load is still there.
		expect(view.getByRole('alert')).toBeTruthy();
		expect(api.signalAllAcceptedCredentials).not.toHaveBeenCalled();
		expect(window.localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(['dXNlci0x']));
	});
});

describe('a page whose tenant answers', () => {
	it('never asks for the tenant status', async () => {
		window.history.replaceState({}, '', '/login');
		mocks.page.url = new URL('https://tenant.example.test/login');
		mocks.flowStart.mockReset().mockResolvedValue({ data: null, error: { error: 'not_found' } });
		mocks.methods.mockReset().mockResolvedValue({
			data: {
				methods: {
					passkey: { enabled: true, loginEnabled: true, signupEnabled: true, capabilities: [] },
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
			},
			error: null
		});
		const fetcher = tenantStatus({ status: 'deleted', host: HOST });

		render(LoginHarness, { props: { data: { authenticationMethods: null } } });

		await waitFor(() => expect(mocks.methods).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(statusCalls(fetcher)).toHaveLength(0);
		vi.unstubAllGlobals();
	});
});
