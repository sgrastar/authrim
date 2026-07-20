import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminConsentGateBindingsAPI } from './admin-consent-gate-bindings';

describe('adminConsentGateBindingsAPI', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('previews the effective target binding without sending a candidate policy ID', async () => {
		const effective = {
			gate_kind: 'oidc_authorization' as const,
			target_type: 'oidc_client' as const,
			target_id: 'client-a',
			policy_id: 'policy-a',
			source: 'exact_binding' as const,
			binding_id: 'binding-a',
			policy: { id: 'policy-a', display_name: 'Policy A', description: null },
			statement_versions: [],
			affected_targets: []
		};
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ effective }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(
			adminConsentGateBindingsAPI.preview({
				gate_kind: 'oidc_authorization',
				target_type: 'oidc_client',
				target_id: 'client-a',
				node_config: { policy_resolution: 'target_binding' }
			})
		).resolves.toEqual(effective);

		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/api/admin/consent-gate-policy-bindings/preview'),
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({
					gate_kind: 'oidc_authorization',
					target_type: 'oidc_client',
					target_id: 'client-a',
					node_config: { policy_resolution: 'target_binding' }
				})
			})
		);
	});

	it('surfaces stable API errors when a required policy cannot be resolved', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					error: 'configuration_error',
					error_description: 'A required Consent Gate Policy could not be resolved'
				}),
				{ status: 409, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(
			adminConsentGateBindingsAPI.preview({
				gate_kind: 'legal_document',
				target_type: 'tenant',
				target_id: null,
				node_config: { policy_resolution: 'target_binding', policy_required: true }
			})
		).rejects.toThrow('A required Consent Gate Policy could not be resolved');
	});
});
