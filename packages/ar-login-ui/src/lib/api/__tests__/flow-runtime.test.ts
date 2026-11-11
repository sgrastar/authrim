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
