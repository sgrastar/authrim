// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APPROVAL_ENDPOINTS } from './approval-endpoints';

vi.mock('$app/environment', () => ({
	browser: true,
	dev: false,
	building: false,
	version: 'test'
}));

vi.mock('$lib/stores/diagnostic', () => ({
	getDiagnosticSessionId: vi.fn(() => 'diag-test')
}));

async function loadClient() {
	vi.resetModules();
	return import('./client');
}

function installFetch(body: unknown = { success: true }, status = 200) {
	const fetchMock = vi.fn<typeof fetch>(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json' }
			})
	);
	Object.defineProperty(globalThis, 'fetch', { value: fetchMock, configurable: true });
	return fetchMock;
}

function sent(fetchMock: ReturnType<typeof installFetch>) {
	const [input, init] = fetchMock.mock.calls[0]!;
	const url = new URL(input.toString());
	return {
		origin: url.origin,
		path: url.pathname,
		method: init?.method ?? 'GET',
		credentials: init?.credentials,
		body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
	};
}

describe('LoginUI device and CIBA approval client', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionStorage.clear();
	});

	it('pins the endpoints to the routes ar-async serves', () => {
		expect(APPROVAL_ENDPOINTS).toEqual({
			deviceLookup: { method: 'POST', path: '/api/devices/lookup' },
			deviceDecide: { method: 'POST', path: '/api/devices/verify' },
			cibaPending: { method: 'GET', path: '/api/ciba/pending' },
			cibaDetails: { method: 'GET', path: '/api/ciba/requests/:auth_req_id' },
			cibaApprove: { method: 'POST', path: '/api/ciba/approve' },
			cibaDeny: { method: 'POST', path: '/api/ciba/deny' }
		});
	});

	it.each([
		[
			'looks a device code up',
			(api: Awaited<ReturnType<typeof loadClient>>) => api.deviceFlowAPI.lookup('WDJBMJHT'),
			APPROVAL_ENDPOINTS.deviceLookup.path,
			APPROVAL_ENDPOINTS.deviceLookup.method,
			{ user_code: 'WDJBMJHT' }
		],
		[
			'approves a device code',
			(api: Awaited<ReturnType<typeof loadClient>>) => api.deviceFlowAPI.approve('WDJBMJHT'),
			APPROVAL_ENDPOINTS.deviceDecide.path,
			APPROVAL_ENDPOINTS.deviceDecide.method,
			{ user_code: 'WDJBMJHT', approve: true }
		],
		[
			'denies a device code',
			(api: Awaited<ReturnType<typeof loadClient>>) => api.deviceFlowAPI.deny('WDJBMJHT'),
			APPROVAL_ENDPOINTS.deviceDecide.path,
			APPROVAL_ENDPOINTS.deviceDecide.method,
			{ user_code: 'WDJBMJHT', approve: false }
		],
		[
			'approves a CIBA request',
			(api: Awaited<ReturnType<typeof loadClient>>) => api.cibaAPI.approve('auth-req-1'),
			APPROVAL_ENDPOINTS.cibaApprove.path,
			APPROVAL_ENDPOINTS.cibaApprove.method,
			{ auth_req_id: 'auth-req-1' }
		],
		[
			'denies a CIBA request',
			(api: Awaited<ReturnType<typeof loadClient>>) => api.cibaAPI.reject('auth-req-1'),
			APPROVAL_ENDPOINTS.cibaDeny.path,
			APPROVAL_ENDPOINTS.cibaDeny.method,
			{ auth_req_id: 'auth-req-1' }
		]
	])('%s with the session cookie on the same origin', async (_label, call, path, method, body) => {
		const fetchMock = installFetch();
		const api = await loadClient();

		await call(api);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sent(fetchMock)).toEqual({
			origin: window.location.origin,
			path,
			method,
			credentials: 'include',
			body
		});
	});

	it('lists pending CIBA requests with their times converted to epoch seconds', async () => {
		// ar-async sends the CIBA store's epoch milliseconds; the page counts in seconds.
		const request = {
			auth_req_id: 'auth-req-1',
			client_name: 'Acme Bank',
			created_at: 1_770_000_000_000,
			expires_at: 1_770_000_300_999
		};
		const fetchMock = installFetch({ requests: [request] });
		const { cibaAPI } = await loadClient();

		const result = await cibaAPI.getPending();

		expect(result).toEqual({
			data: [{ ...request, created_at: 1_770_000_000, expires_at: 1_770_000_300 }]
		});
		expect(sent(fetchMock)).toMatchObject({
			path: APPROVAL_ENDPOINTS.cibaPending.path,
			method: 'GET',
			credentials: 'include',
			body: undefined
		});
	});

	it('reads one CIBA request with its id as a single path segment', async () => {
		const fetchMock = installFetch({ auth_req_id: 'a/b' });
		const { cibaAPI } = await loadClient();

		await cibaAPI.getData('a/b');

		expect(fetchMock.mock.calls[0]![0].toString()).toContain('/api/ciba/requests/a%2Fb');
		expect(sent(fetchMock).method).toBe('GET');
	});

	it.each([
		['consent_withdrawn', 400],
		['temporarily_unavailable', 503],
		['invalid_code', 404]
	])('returns the server error %s to the page', async (error, status) => {
		installFetch({ success: false, error, error_description: 'described' }, status);
		const { deviceFlowAPI } = await loadClient();

		const result = await deviceFlowAPI.approve('WDJBMJHT');

		expect(result).toEqual({
			error: { success: false, error, error_description: 'described' }
		});
	});

	it('passes a CIBA list failure through instead of an empty list', async () => {
		installFetch({ error: 'login_required', error_code: 'AR000003' }, 401);
		const { cibaAPI } = await loadClient();

		const result = await cibaAPI.getPending();

		expect(result).toEqual({ error: { error: 'login_required', error_code: 'AR000003' } });
	});
});
