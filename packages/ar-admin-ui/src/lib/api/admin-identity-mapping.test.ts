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
						destinationProfiles: [],
						attributeGroups: [],
						attributeFields: [],
						templates: [],
						rows: [],
						summary: { total: 0, pass: 0, attention: 0, blocked: 0, deferred: 0 },
						federationTrustSources: [],
						federationMetadataDocuments: [],
						reviewTasks: [],
						profiles: [],
						result: {
							id: 'persistent profile 1',
							opaque: 'opaque',
							secretMaterialIncluded: false
						}
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

	function requestHeader(init: unknown, headerName: string): string | undefined {
		if (!init || typeof init !== 'object' || !('headers' in init)) return undefined;
		const headers = (init as { headers?: HeadersInit }).headers;
		if (!headers) return undefined;
		if (headers instanceof Headers) return headers.get(headerName) ?? undefined;
		if (Array.isArray(headers)) {
			return headers.find(([key]) => key.toLowerCase() === headerName.toLowerCase())?.[1];
		}
		return Object.entries(headers).find(
			([key]) => key.toLowerCase() === headerName.toLowerCase()
		)?.[1];
	}

	it('loads field mapping control-plane collections from admin endpoints', async () => {
		await adminIdentityMappingAPI.listFieldMappingSets();
		await adminIdentityMappingAPI.listCatalogs();
		await adminIdentityMappingAPI.listProtocolSchemas();
		await adminIdentityMappingAPI.listExternalSchemas();
		await adminIdentityMappingAPI.listSourceProfiles();
		await adminIdentityMappingAPI.listDestinationProfiles();
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
		await adminIdentityMappingAPI.updateSourceProfile('source profile 1', {
			displayName: 'Workday CSV updated',
			schema: { sourceType: 'csv', columns: [] }
		});
		await adminIdentityMappingAPI.reviewSourceProfileVersion('source profile 1', 'version 1');
		await adminIdentityMappingAPI.activateSourceProfileVersion('source profile 1', 'version 1');
		await adminIdentityMappingAPI.deleteSourceProfile('source profile 1');
		await adminIdentityMappingAPI.createDestinationProfile({
			destinationType: 'oidc',
			profileKey: 'library_oidc',
			displayName: 'Library OIDC',
			schema: { destinationType: 'oidc', claims: [{ claimName: 'sub', surfaces: ['id_token'] }] }
		});
		await adminIdentityMappingAPI.updateDestinationProfile('destination profile 1', {
			displayName: 'Library OIDC updated',
			schema: { destinationType: 'oidc', claims: [{ claimName: 'sub', surfaces: ['id_token'] }] }
		});
		await adminIdentityMappingAPI.reviewDestinationProfileVersion(
			'destination profile 1',
			'version 1'
		);
		await adminIdentityMappingAPI.activateDestinationProfileVersion(
			'destination profile 1',
			'version 1'
		);
		await adminIdentityMappingAPI.deleteDestinationProfile('destination profile 1');
		await adminIdentityMappingAPI.listAttributeGroups();
		await adminIdentityMappingAPI.createAttributeGroup({
			protocol: 'oidc',
			groupType: 'scope',
			groupKey: 'library',
			displayName: 'Library',
			fieldKeys: ['library_card']
		});
		await adminIdentityMappingAPI.listAttributeFields();
		await adminIdentityMappingAPI.createAttributeField({
			protocol: 'oidc',
			fieldKey: 'library_card',
			displayName: 'Library card',
			surfaces: ['userinfo']
		});
		await adminIdentityMappingAPI.listTemplates();
		await adminIdentityMappingAPI.getSchemaReadiness();
		await adminIdentityMappingAPI.listFederationTrustSources();
		await adminIdentityMappingAPI.listFederationMetadataDocuments('trust/source 1');
		await adminIdentityMappingAPI.listReviewTasks({ status: 'open', limit: 25 });
		await adminIdentityMappingAPI.listPersistentIdentifierProfiles();
		await adminIdentityMappingAPI.createPersistentIdentifierProfile({
			displayName: 'Default persistent IDs'
		});
		await adminIdentityMappingAPI.updatePersistentIdentifierProfile('persistent profile 1', {
			displayName: 'Updated persistent IDs'
		});
		await adminIdentityMappingAPI.previewPersistentIdentifier({
			profileId: 'persistent profile 1',
			subject: 'user-1',
			audience: 'https://sp.example.edu/shibboleth-sp'
		});
		await adminIdentityMappingAPI.deletePersistentIdentifierProfile('persistent profile 1');
		await adminIdentityMappingAPI.createFieldMappingSet({
			fieldMappingKey: 'ui_draft',
			displayName: 'UI Draft'
		});
		await adminIdentityMappingAPI.createFieldMappingVersion('field mapping set 1', {
			versionLabel: 'ui-draft',
			rules: [
				{
					ruleKey: 'email',
					ruleKind: 'source_mapping',
					action: 'map',
					edges: [{ sourceRef: { path: 'Email' }, targetRef: { path: 'email' } }],
					transforms: [{ edgeIndex: 0, operation: 'trim' }]
				}
			]
		});
		await adminIdentityMappingAPI.listFieldMappingVersions('field mapping set 1');
		await adminIdentityMappingAPI.rollbackFieldMappingSet('field mapping set 1');
		await adminIdentityMappingAPI.publishFieldMappingVersion('field mapping set 1', 'version 1');
		await adminIdentityMappingAPI.compileFieldMappingVersion('field mapping set 1', 'version 1', {
			catalogVersionId: 'catalog version 1'
		});
		await adminIdentityMappingAPI.activateFieldMappingVersion('field mapping set 1', 'version 1', {
			snapshotId: 'snapshot 1',
			activationScope: { kind: 'tenant', id: 'tenant_a' }
		});
		await adminIdentityMappingAPI.deactivateFieldMappingVersion('field mapping set 1', 'version 1');
		await adminIdentityMappingAPI.transitionReviewTask('review task 1', {
			status: 'resolved',
			reasonCodes: ['operator_resolved']
		});

		expect(fetchMock.mock.calls.map((call) => requestPath(call[0]))).toEqual([
			'/api/admin/field-mapping/field-mapping-sets',
			'/api/admin/field-mapping/catalogs',
			'/api/admin/field-mapping/protocol-schemas',
			'/api/admin/field-mapping/external-schemas',
			'/api/admin/field-mapping/source-profiles',
			'/api/admin/field-mapping/destination-profiles',
			'/api/admin/field-mapping/source-profiles/csv/parse',
			'/api/admin/field-mapping/source-profiles',
			'/api/admin/field-mapping/source-profiles/source%20profile%201',
			'/api/admin/field-mapping/source-profiles/source%20profile%201/versions/version%201/review',
			'/api/admin/field-mapping/source-profiles/source%20profile%201/versions/version%201/activate',
			'/api/admin/field-mapping/source-profiles/source%20profile%201',
			'/api/admin/field-mapping/destination-profiles',
			'/api/admin/field-mapping/destination-profiles/destination%20profile%201',
			'/api/admin/field-mapping/destination-profiles/destination%20profile%201/versions/version%201/review',
			'/api/admin/field-mapping/destination-profiles/destination%20profile%201/versions/version%201/activate',
			'/api/admin/field-mapping/destination-profiles/destination%20profile%201',
			'/api/admin/field-mapping/attribute-groups',
			'/api/admin/field-mapping/attribute-groups',
			'/api/admin/field-mapping/attribute-fields',
			'/api/admin/field-mapping/attribute-fields',
			'/api/admin/field-mapping/templates',
			'/api/admin/field-mapping/schema-readiness',
			'/api/admin/field-mapping/federation-trust-sources',
			'/api/admin/field-mapping/federation-trust-sources/trust%2Fsource%201/metadata-documents',
			'/api/admin/field-mapping/review-tasks?status=open&limit=25',
			'/api/admin/field-mapping/persistent-identifier-profiles',
			'/api/admin/field-mapping/persistent-identifier-profiles',
			'/api/admin/field-mapping/persistent-identifier-profiles/persistent%20profile%201',
			'/api/admin/field-mapping/persistent-identifier-profiles/preview',
			'/api/admin/field-mapping/persistent-identifier-profiles/persistent%20profile%201',
			'/api/admin/field-mapping/field-mapping-sets',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/rollback',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions/version%201/publish',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions/version%201/compile',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions/version%201/activate',
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201/versions/version%201/deactivate',
			'/api/admin/field-mapping/review-tasks/review%20task%201/transition'
		]);
		expect(fetchMock.mock.calls[6][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[7][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[8][1]).toMatchObject({ method: 'PUT' });
		expect(fetchMock.mock.calls[9][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[10][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[11][1]).toMatchObject({ method: 'DELETE' });
		expect(fetchMock.mock.calls[12][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[13][1]).toMatchObject({ method: 'PUT' });
		expect(fetchMock.mock.calls[14][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[15][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[16][1]).toMatchObject({ method: 'DELETE' });
		expect(fetchMock.mock.calls[18][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[26][1]).not.toMatchObject({ method: expect.any(String) });
		expect(fetchMock.mock.calls[27][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[28][1]).toMatchObject({ method: 'PUT' });
		expect(fetchMock.mock.calls[29][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[30][1]).toMatchObject({ method: 'DELETE' });
		expect(fetchMock.mock.calls[31][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[32][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[33][1]).not.toMatchObject({ method: expect.any(String) });
		expect(fetchMock.mock.calls[34][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[35][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[36][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[37][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[38][1]).toMatchObject({ method: 'POST' });
		expect(fetchMock.mock.calls[39][1]).toMatchObject({ method: 'POST' });
		for (const callIndex of [27, 28, 29, 30, 31, 32, 34, 35, 36, 37, 38, 39]) {
			expect(requestHeader(fetchMock.mock.calls[callIndex][1], 'Idempotency-Key')).toEqual(
				expect.any(String)
			);
		}
	});

	it('surfaces API error descriptions', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error_description: 'schema-readiness gate failed' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminIdentityMappingAPI.listFieldMappingSets()).rejects.toThrow(
			'schema-readiness gate failed'
		);
	});

	it('sends an empty JSON body when deleting a field mapping set', async () => {
		fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ result: { deleted: true } })));

		await adminIdentityMappingAPI.deleteFieldMappingSet('field mapping set 1');

		expect(requestPath(fetchMock.mock.calls[0][0])).toBe(
			'/api/admin/field-mapping/field-mapping-sets/field%20mapping%20set%201'
		);
		expect(fetchMock.mock.calls[0][1]).toMatchObject({
			method: 'DELETE',
			body: '{}'
		});
		expect(requestHeader(fetchMock.mock.calls[0][1], 'Idempotency-Key')).toEqual(
			expect.any(String)
		);
	});
});
