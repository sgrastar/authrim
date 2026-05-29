import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminIdentityMappingAPI } from './admin-identity-mapping';

describe('adminIdentityMappingAPI', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						policies: [],
						catalogs: [],
						protocolSchemas: [],
						externalSchemas: [],
						templates: [],
						federationTrustSources: [],
						federationMetadataDocuments: [],
						reviewTasks: []
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
		);
		vi.stubGlobal('fetch', fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function requestPath(input: unknown): string {
		const value = String(input);
		if (value.startsWith('http://') || value.startsWith('https://')) {
			const url = new URL(value);
			return `${url.pathname}${url.search}`;
		}
		return value;
	}

	it('loads identity mapping control-plane collections from admin endpoints', async () => {
		await adminIdentityMappingAPI.listPolicies();
		await adminIdentityMappingAPI.listCatalogs();
		await adminIdentityMappingAPI.listProtocolSchemas();
		await adminIdentityMappingAPI.listExternalSchemas();
		await adminIdentityMappingAPI.listTemplates();
		await adminIdentityMappingAPI.listFederationTrustSources();
		await adminIdentityMappingAPI.listFederationMetadataDocuments('trust/source 1');
		await adminIdentityMappingAPI.listReviewTasks({ status: 'open', limit: 25 });
		await adminIdentityMappingAPI.rollbackPolicy('policy set 1');
		await adminIdentityMappingAPI.publishPolicyVersion('policy set 1', 'version 1');
		await adminIdentityMappingAPI.compilePolicyVersion('policy set 1', 'version 1', {
			catalogVersionId: 'catalog version 1'
		});
		await adminIdentityMappingAPI.activatePolicyVersion('policy set 1', 'version 1', {
			snapshotId: 'snapshot 1',
			activationScope: { kind: 'tenant', id: 'tenant_a' }
		});
		await adminIdentityMappingAPI.transitionReviewTask('review task 1', {
			status: 'resolved',
			reasonCodes: ['operator_resolved']
		});

		expect(fetchMock.mock.calls.map((call) => requestPath(call[0]))).toEqual([
			'/api/admin/identity-mapping/policies',
			'/api/admin/identity-mapping/catalogs',
			'/api/admin/identity-mapping/protocol-schemas',
			'/api/admin/identity-mapping/external-schemas',
			'/api/admin/identity-mapping/templates',
			'/api/admin/identity-mapping/federation-trust-sources',
			'/api/admin/identity-mapping/federation-trust-sources/trust%2Fsource%201/metadata-documents',
			'/api/admin/identity-mapping/review-tasks?status=open&limit=25',
			'/api/admin/identity-mapping/policies/policy%20set%201/rollback',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/publish',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/compile',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/activate',
			'/api/admin/identity-mapping/review-tasks/review%20task%201/transition'
		]);
		expect(fetchMock.mock.calls[8][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[9][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[10][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[11][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[12][1]).toMatchObject({ method: 'POST' });
	});

	it('surfaces API error descriptions', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error_description: 'schema-readiness gate failed' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminIdentityMappingAPI.listPolicies()).rejects.toThrow(
			'schema-readiness gate failed'
		);
	});
});
