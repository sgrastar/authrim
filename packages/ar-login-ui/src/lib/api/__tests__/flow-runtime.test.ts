// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const authrimFetchMock = vi.hoisted(() => vi.fn<typeof fetch>());

vi.mock('../../authrim/fetch', () => ({
	authrimFetch: authrimFetchMock
}));

vi.mock('../client', () => ({
	buildDiagnosticHeaders: () => new Headers({ 'X-Diagnostic-Session-Id': 'diag_test' }),
	resolveApiBaseUrl: () => 'https://first.test.authrim.com'
}));

async function loadApi() {
	vi.resetModules();
	return import('../flow-runtime');
}

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

describe('flow runtime API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts a LoginUI runtime interaction with the selected target', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse({
				schema_version: 'authrim.login_ui.contract.v1',
				interaction: { id: 'interaction_1' },
				contract: { flow_kind: 'login', ui: { steps: [] } },
				contract_hash: 'hash',
				signature: 'sig',
				expires_in: 600,
				resumed: false
			})
		);

		const result = await flowRuntimeAPI.start({
			flow_kind: 'login',
			target_type: 'oidc_client',
			target_id: 'client_1',
			client_id: 'client_1',
			authorization_challenge_id: 'login_challenge_1'
		});

		expect(result.data?.interaction.id).toBe('interaction_1');
		expect(authrimFetchMock).toHaveBeenCalledWith(
			'/api/v1/login/interactions/start',
			expect.objectContaining({
				baseUrl: 'https://first.test.authrim.com',
				method: 'POST',
				body: JSON.stringify({
					flow_kind: 'login',
					target_type: 'oidc_client',
					target_id: 'client_1',
					client_id: 'client_1',
					authorization_challenge_id: 'login_challenge_1'
				})
			})
		);
	});

	it('goes back to a screen through the interaction resource, with the screens it can go back to', async () => {
		const { flowRuntimeAPI, backScreensOf } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse({
				schema_version: 'authrim.login_ui.contract.v1',
				interaction: { id: 'interaction_1', state: 'active', current_step_id: 'a:step' },
				step: { id: 'a:step', component: 'screen' },
				completed: false,
				output: null,
				back_screens: ['earlier', 'Not A Key']
			})
		);
		const input = {
			step_id: 'b:step',
			node_id: 'b',
			contract_hash: 'hash',
			signature: 'sig',
			target_screen: 'step_one'
		};
		const result = await flowRuntimeAPI.back('interaction_1', input);
		expect(result.data?.step?.id).toBe('a:step');
		expect(backScreensOf(result.data)).toEqual(['earlier']);
		expect(authrimFetchMock).toHaveBeenCalledWith(
			'/api/v1/login/interactions/interaction_1/back',
			expect.objectContaining({ method: 'POST', body: JSON.stringify(input) })
		);
	});

	it('answers a refused way back as an error', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					error: 'back_not_allowed',
					error_description: 'This screen cannot be gone back to from here',
					category: 'recoverable',
					action: 'retry_step'
				},
				409
			)
		);
		const result = await flowRuntimeAPI.back('interaction_1', {
			step_id: 'b:step',
			contract_hash: 'hash',
			signature: 'sig',
			target_screen: 'step_one'
		});
		expect(result.data).toBeUndefined();
		expect(result.error).toMatchObject({
			error: 'back_not_allowed',
			category: 'recoverable',
			action: 'retry_step'
		});
	});

	it('reads whether a start answer lets the person go back to the app', async () => {
		const { cancelAvailableOf } = await loadApi();
		expect(cancelAvailableOf({ interaction: { id: 'i', cancel_available: true } })).toBe(true);
		expect(cancelAvailableOf({ interaction: { id: 'i', cancel_available: false } })).toBe(false);
		expect(cancelAvailableOf({ interaction: { id: 'i' } })).toBe(false);
		expect(cancelAvailableOf({ interaction: { id: 'i', cancel_available: 'true' } })).toBe(false);
		expect(cancelAvailableOf(null)).toBe(false);
	});

	it('goes back to the app through the interaction resource, answered with where to go', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse({ redirect_url: 'https://app.example/cb?error=access_denied' })
		);
		const input = { step_id: 'a:step', node_id: 'a', contract_hash: 'hash', signature: 'sig' };
		const result = await flowRuntimeAPI.cancel('interaction_1', input);
		expect(result.data?.redirect_url).toBe('https://app.example/cb?error=access_denied');
		expect(authrimFetchMock).toHaveBeenCalledWith(
			'/api/v1/login/interactions/interaction_1/cancel',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'Content-Type': 'application/json',
					// A form post as data, not an HTML page the SPA cannot use.
					'X-Authrim-Relay': 'structured'
				}),
				body: JSON.stringify(input)
			})
		);
	});

	it('answers a cancel as a form post as data when the application uses form_post', async () => {
		const { flowRuntimeAPI } = await loadApi();
		const formPost = { action: 'https://app.example/cb', fields: [['error', 'access_denied']] };
		authrimFetchMock.mockResolvedValueOnce(jsonResponse({ form_post: formPost }));
		const result = await flowRuntimeAPI.cancel('interaction_1', {
			contract_hash: 'hash',
			signature: 'sig'
		});
		expect(result.data?.form_post).toEqual(formPost);
	});

	it('starts a SAML sign-in with the browser-held login nonce', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(jsonResponse({ interaction: { id: 'i' } }));
		await flowRuntimeAPI.start({
			flow_kind: 'login',
			saml_request_id: 'req-1',
			saml_login_nonce: 'nonce-1'
		});
		expect(JSON.parse(String(authrimFetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			saml_request_id: 'req-1',
			saml_login_nonce: 'nonce-1'
		});
	});

	it('answers a refused way back to the app as an error', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse(
				{ error: 'cancel_not_available', error_description: 'This sign-in cannot be cancelled' },
				409
			)
		);
		const result = await flowRuntimeAPI.cancel('interaction_1', {
			contract_hash: 'hash',
			signature: 'sig'
		});
		expect(result.data).toBeUndefined();
		expect(result.error).toMatchObject({ error: 'cancel_not_available' });
		// Not yet possible (503): an error to show, to try again.
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse({ error: 'temporarily_unavailable', error_description: 'Try again' }, 503)
		);
		const busy = await flowRuntimeAPI.cancel('interaction_1', {
			contract_hash: 'hash',
			signature: 'sig'
		});
		expect(busy.data).toBeUndefined();
		expect(busy.error?.error).toBe('temporarily_unavailable');
		authrimFetchMock.mockRejectedValueOnce(new Error('offline'));
		const offline = await flowRuntimeAPI.cancel('interaction_1', {
			contract_hash: 'hash',
			signature: 'sig'
		});
		expect(offline.error?.error).toBe('network_error');
	});

	it('submits the active runtime step to the interaction resource', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse({
				schema_version: 'authrim.login_ui.contract.v1',
				interaction: { id: 'interaction_1', state: 'active' },
				step: null,
				completed: true,
				output: { action: 'complete' }
			})
		);

		const result = await flowRuntimeAPI.submit('interaction_1', {
			step_id: 'auth:step',
			node_id: 'auth',
			selected_handle: 'passkey',
			contract_hash: 'hash',
			signature: 'sig'
		});

		expect(result.data?.completed).toBe(true);
		expect(authrimFetchMock).toHaveBeenCalledWith(
			'/api/v1/login/interactions/interaction_1/submit',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					step_id: 'auth:step',
					node_id: 'auth',
					selected_handle: 'passkey',
					contract_hash: 'hash',
					signature: 'sig'
				})
			})
		);
	});

	it('returns structured runtime errors without throwing', async () => {
		const { flowRuntimeAPI } = await loadApi();
		authrimFetchMock.mockResolvedValueOnce(
			jsonResponse(
				{
					error: 'interaction_expired',
					error_description: 'The login interaction has expired',
					error_code: 'AR_FLOW_EXPIRED',
					category: 'restart_required',
					action: 'restart_interaction',
					interaction_id: 'interaction_1'
				},
				409
			)
		);

		const result = await flowRuntimeAPI.submit('interaction_1', {
			step_id: 'auth:step',
			contract_hash: 'hash',
			signature: 'sig'
		});

		expect(result.error?.category).toBe('restart_required');
		expect(result.error?.action).toBe('restart_interaction');
	});
});
