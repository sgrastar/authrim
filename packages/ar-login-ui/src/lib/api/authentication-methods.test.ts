// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const authrimFetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

vi.mock('$lib/authrim/fetch', () => ({
	authrimFetch: authrimFetchMock
}));

async function loadApi() {
	vi.resetModules();
	return import('./authentication-methods');
}

function createAuthenticationMethodsResponse(cacheTTL = 180) {
	return {
		methods: {
			passkey: { enabled: true, capabilities: [] },
			emailCode: { enabled: true, steps: [] },
			directoryPassword: { enabled: false, label: 'Organization ID', steps: [] },
			humanVerification: {
				enabled: false,
				provider: 'none',
				siteKey: null,
				loginEnabled: false,
				signupEnabled: false,
				reauthEnabled: false,
				failurePolicy: 'fail_closed',
				widget: {
					actionPrefix: 'authrim',
					theme: 'auto',
					size: 'flexible',
					mode: 'managed'
				}
			},
			external: { enabled: false, providers: [] }
		},
		ui: {
			theme: 'default',
			variant: 'default',
			branding: {
				logoUrl: null,
				brandName: 'Authrim'
			},
			supportedLocales: ['en', 'ja'],
			selfService: {
				accountPageEnabled: true,
				accountPagePath: '/account'
			}
		},
		meta: {
			cacheTTL,
			revision: 'test'
		}
	};
}

describe('authentication methods API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('deduplicates concurrent authentication-methods requests', async () => {
		const { fetchAuthenticationMethods } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const [first, second] = await Promise.all([
			fetchAuthenticationMethods(),
			fetchAuthenticationMethods()
		]);

		expect(authrimFetchMock).toHaveBeenCalledTimes(1);
		expect(first.data?.ui.selfService?.accountPageEnabled).toBe(true);
		expect(second.data?.ui.selfService?.accountPageEnabled).toBe(true);
	});

	it('serves subsequent requests from the in-memory TTL cache', async () => {
		const { fetchAuthenticationMethods } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await fetchAuthenticationMethods();
		await fetchAuthenticationMethods();

		expect(authrimFetchMock).toHaveBeenCalledTimes(1);
	});

	it('allows the HTTP cache on a fresh page request while retaining the in-memory TTL cache', async () => {
		const { fetchAuthenticationMethods } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await fetchAuthenticationMethods();

		expect(authrimFetchMock).toHaveBeenCalledWith(
			'/api/auth/authentication-methods',
			expect.objectContaining({ method: 'GET' })
		);
		expect(authrimFetchMock.mock.calls[0]?.[1]).not.toMatchObject({ cache: 'reload' });
	});

	it('bypasses memory and HTTP caches when a suspended page resumes', async () => {
		const { fetchAuthenticationMethods } = await loadApi();
		authrimFetchMock
			.mockResolvedValueOnce(
				new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);

		await fetchAuthenticationMethods();
		await fetchAuthenticationMethods({ forceRefresh: true });

		expect(authrimFetchMock).toHaveBeenCalledTimes(2);
		expect(authrimFetchMock.mock.calls[1]?.[1]).toMatchObject({ cache: 'reload' });
	});

	it('does not reuse a request that was suspended before the page resumed', async () => {
		const { fetchAuthenticationMethods } = await loadApi();
		let resolveSuspendedRequest: ((response: Response) => void) | undefined;
		authrimFetchMock
			.mockImplementationOnce(
				() =>
					new Promise<Response>((resolve) => {
						resolveSuspendedRequest = resolve;
					})
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);

		const suspendedRequest = fetchAuthenticationMethods();
		const resumedRequest = fetchAuthenticationMethods({ forceRefresh: true });

		expect(authrimFetchMock).toHaveBeenCalledTimes(2);
		await expect(resumedRequest).resolves.toHaveProperty('data.meta.revision', 'test');
		resolveSuspendedRequest?.(
			new Response(JSON.stringify(createAuthenticationMethodsResponse()), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		await suspendedRequest;
	});
});
