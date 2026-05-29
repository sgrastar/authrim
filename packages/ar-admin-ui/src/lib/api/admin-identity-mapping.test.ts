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
						sourceProfiles: [],
						templates: [],
						rows: [],
						summary: { total: 0, pass: 0, attention: 0, blocked: 0, deferred: 0 },
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
		await adminIdentityMappingAPI.listSourceProfiles();
		await adminIdentityMappingAPI.parseCsvSourceProfile({
			contentBase64: 'RW1haWwKYWxpY2VAZXhhbXBsZS50ZXN0',
			encoding: 'utf-8'
		});
		await adminIdentityMappingAPI.createSourceProfile({
			sourceType: 'csv',
			profileKey: 'workday_csv',
			displayName: 'Workday CSV',
			schema: { sourceType: 'csv', columns: [] }
		});
		await adminIdentityMappingAPI.reviewSourceProfileVersion('source profile 1', 'version 1');
		await adminIdentityMappingAPI.activateSourceProfileVersion('source profile 1', 'version 1');
		await adminIdentityMappingAPI.listTemplates();
		await adminIdentityMappingAPI.getSchemaReadiness();
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
			'/api/admin/identity-mapping/source-profiles',
			'/api/admin/identity-mapping/source-profiles/csv/parse',
			'/api/admin/identity-mapping/source-profiles',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201/versions/version%201/review',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201/versions/version%201/activate',
			'/api/admin/identity-mapping/templates',
			'/api/admin/identity-mapping/schema-readiness',
			'/api/admin/identity-mapping/federation-trust-sources',
			'/api/admin/identity-mapping/federation-trust-sources/trust%2Fsource%201/metadata-documents',
			'/api/admin/identity-mapping/review-tasks?status=open&limit=25',
			'/api/admin/identity-mapping/policies/policy%20set%201/rollback',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/publish',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/compile',
			'/api/admin/identity-mapping/policies/policy%20set%201/versions/version%201/activate',
			'/api/admin/identity-mapping/review-tasks/review%20task%201/transition'
		]);
		expect(fetchMock.mock.calls[5][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[6][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[7][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[8][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[14][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[15][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[16][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[17][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[18][1]).toMatchObject({ method: 'POST' });
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
