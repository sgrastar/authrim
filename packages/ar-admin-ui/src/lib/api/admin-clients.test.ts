import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminClientsAPI } from './admin-clients';

describe('adminClientsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts downstream grant fields when creating a client', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ client: { client_id: 'client_1', client_name: 'svc' } }), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await adminClientsAPI.create({
			client_name: 'svc',
			redirect_uris: [],
			grant_types: ['client_credentials'],
			token_exchange_allowed: true,
			allowed_subject_token_clients: ['svc-client-a'],
			allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
			delegation_mode: 'delegation',
			client_credentials_allowed: true,
			allowed_scopes: ['openid', 'profile'],
			default_scope: 'openid profile',
			default_audience: 'svc://op-userinfo/customer-profile'
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/clients'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					client_name: 'svc',
					redirect_uris: [],
					grant_types: ['client_credentials'],
					token_exchange_allowed: true,
					allowed_subject_token_clients: ['svc-client-a'],
					allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
					delegation_mode: 'delegation',
					client_credentials_allowed: true,
					allowed_scopes: ['openid', 'profile'],
					default_scope: 'openid profile',
					default_audience: 'svc://op-userinfo/customer-profile'
				})
			})
		);
	});

	it('posts downstream grant fields when updating a client', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ client: { client_id: 'client_1', client_name: 'svc' } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await adminClientsAPI.update('client_1', {
			token_exchange_allowed: false,
			allowed_subject_token_clients: [],
			allowed_token_exchange_resources: ['svc://op-userinfo/customer-export'],
			delegation_mode: 'impersonation',
			client_credentials_allowed: false,
			allowed_scopes: ['profile_export'],
			default_scope: null,
			default_audience: null
		});

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/clients/client_1'),
			expect.objectContaining({
				method: 'PUT',
				body: JSON.stringify({
					token_exchange_allowed: false,
					allowed_subject_token_clients: [],
					allowed_token_exchange_resources: ['svc://op-userinfo/customer-export'],
					delegation_mode: 'impersonation',
					client_credentials_allowed: false,
					allowed_scopes: ['profile_export'],
					default_scope: null,
					default_audience: null
				})
			})
		);
	});
});
