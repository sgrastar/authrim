import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminTenantsAPI, type CloneTenantResponse } from './admin-tenants';

describe('adminTenantsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts explicit clone options to the source tenant clone endpoint', async () => {
		const response = {
			id: 'destination',
			tenant_code: 'destination',
			name: 'Destination',
			description: null,
			lifecycle_state: 'active',
			is_default: false,
			created_at: 1,
			updated_at: 1,
			source_tenant_id: 'source tenant',
			source_tenant_name: 'Source',
			copy: {
				settings: true,
				secret_settings: false,
				clients: true,
				client_credentials: false,
				roles: true,
				admin_access: false,
				webhooks: false,
				webhook_secrets: false
			},
			cloned_items: {
				settings: 1,
				secret_settings_skipped: 0,
				unclassified_settings_skipped: 0,
				clients: 1,
				client_settings: 1,
				client_contracts: 1,
				client_web_origins: 1,
				client_trust_policies: 1,
				client_consent_overrides_skipped: 0,
				client_flow_assignments_skipped: 0,
				roles: 1,
				role_assignment_rules: 1,
				role_references_unresolved: 0,
				role_assignment_rules_skipped: 0,
				admin_roles: 0,
				admin_role_assignments: 0,
				admin_role_assignments_skipped: 0,
				admin_role_inheritance_unresolved: 0,
				webhooks: 0,
				client_webhooks_skipped: 0
			},
			signing_keys: { copied: false, generated: true },
			warnings: []
		} satisfies CloneTenantResponse;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(response), {
				status: 201,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		const result = await adminTenantsAPI.clone(
			'source tenant',
			{
				id: 'destination',
				name: 'Destination',
				copy: response.copy
			},
			'clone-request-1'
		);

		expect(result).toEqual(response);
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/tenants/source%20tenant/clone'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					id: 'destination',
					name: 'Destination',
					copy: response.copy
				})
			})
		);
		expect((fetchMock.mock.calls[0]?.[1]?.headers as Headers).get('Idempotency-Key')).toBe(
			'clone-request-1'
		);
	});

	it('surfaces clone API errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error_description: 'Source tenant must be active' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminTenantsAPI.clone('source', {
				id: 'destination',
				name: 'Destination',
				copy: {
					settings: true,
					secret_settings: false,
					clients: false,
					client_credentials: false,
					roles: true,
					admin_access: false,
					webhooks: false,
					webhook_secrets: false
				}
			})
		).rejects.toThrow('Source tenant must be active');
	});
});
