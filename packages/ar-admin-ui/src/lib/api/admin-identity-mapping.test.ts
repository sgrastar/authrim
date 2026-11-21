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

	it('unwraps the federation trust source delete response', async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ result: { success: true } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);

		await expect(adminIdentityMappingAPI.deleteFederationTrustSource('source-1')).resolves.toEqual({
			success: true
		});
	});

	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});

	describe('listFieldMappingSets (read from the one-step Mapping Set API)', () => {
		const row = (id: string, owner?: string, enabled = true) => ({
			id,
			...(owner === undefined ? {} : { owner }),
			field_mapping_key: id,
			display_name: id,
			enabled
		});

		it("keeps to the tenant's own sets, and leaves out the platform's", async () => {
			fetchMock.mockResolvedValueOnce(
				json({
					sets: [row('own', 'tenant'), row('shared', 'platform'), row('also-own', 'tenant')]
				})
			);

			const result = await adminIdentityMappingAPI.listFieldMappingSets();

			expect(requestPath(fetchMock.mock.calls[0][0])).toBe('/api/admin/identity-mapping/sets');
			expect(result.fieldMappingSets.map((item) => item.id)).toEqual(['own', 'also-own']);
		});

		it('reads a set that is switched on as active and one that is off as a draft', async () => {
			fetchMock.mockResolvedValueOnce(json({ sets: [row('on'), row('off', 'tenant', false)] }));

			const result = await adminIdentityMappingAPI.listFieldMappingSets();

			expect(result.fieldMappingSets.map((item) => item.lifecycleState)).toEqual([
				'active',
				'draft'
			]);
			expect(result.fieldMappingSets[0]).toMatchObject({
				fieldMappingKey: 'on',
				displayName: 'on',
				owner: 'tenant'
			});
		});
	});

	describe('listFieldMappingVersions (read from the set)', () => {
		it('gives the version in use and the Destination Profile it releases into', async () => {
			fetchMock.mockResolvedValueOnce(
				json({
					id: 'set-1',
					enabled: true,
					active_version_id: 'ver-1',
					version_label: 'v3',
					destination_profile_id: 'profile-1'
				})
			);

			const result = await adminIdentityMappingAPI.listFieldMappingVersions('set-1');

			expect(requestPath(fetchMock.mock.calls[0][0])).toBe(
				'/api/admin/identity-mapping/sets/set-1'
			);
			expect(result.fieldMappingVersions).toMatchObject([
				{
					id: 'ver-1',
					fieldMappingSetId: 'set-1',
					lifecycleState: 'active',
					destinationProfileIds: ['profile-1'],
					directions: { source: true, destination: true }
				}
			]);
		});

		it('has no version for a set that is switched off', async () => {
			fetchMock.mockResolvedValueOnce(
				json({ id: 'set-1', enabled: false, active_version_id: null })
			);

			const result = await adminIdentityMappingAPI.listFieldMappingVersions('set-1');

			expect(result.fieldMappingVersions).toEqual([]);
		});
	});

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
		await adminIdentityMappingAPI.listFieldMappingVersions('field mapping set 1');
		await adminIdentityMappingAPI.transitionReviewTask('review task 1', {
			status: 'resolved',
			reasonCodes: ['operator_resolved']
		});

		expect(fetchMock.mock.calls.map((call) => requestPath(call[0]))).toEqual([
			'/api/admin/identity-mapping/sets',
			'/api/admin/identity-mapping/catalogs',
			'/api/admin/identity-mapping/protocol-schemas',
			'/api/admin/identity-mapping/external-schemas',
			'/api/admin/identity-mapping/source-profiles',
			'/api/admin/identity-mapping/destination-profiles',
			'/api/admin/identity-mapping/source-profiles/csv/parse',
			'/api/admin/identity-mapping/source-profiles',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201/versions/version%201/review',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201/versions/version%201/activate',
			'/api/admin/identity-mapping/source-profiles/source%20profile%201',
			'/api/admin/identity-mapping/destination-profiles',
			'/api/admin/identity-mapping/destination-profiles/destination%20profile%201',
			'/api/admin/identity-mapping/destination-profiles/destination%20profile%201/versions/version%201/review',
			'/api/admin/identity-mapping/destination-profiles/destination%20profile%201/versions/version%201/activate',
			'/api/admin/identity-mapping/destination-profiles/destination%20profile%201',
			'/api/admin/identity-mapping/attribute-groups',
			'/api/admin/identity-mapping/attribute-groups',
			'/api/admin/identity-mapping/attribute-fields',
			'/api/admin/identity-mapping/attribute-fields',
			'/api/admin/identity-mapping/templates',
			'/api/admin/identity-mapping/schema-readiness',
			'/api/admin/federation/trust-sources',
			'/api/admin/federation/trust-sources/trust%2Fsource%201/metadata-documents',
			'/api/admin/identity-mapping/review-tasks?status=open&limit=25',
			'/api/admin/identity-mapping/sets/field%20mapping%20set%201',
			'/api/admin/identity-mapping/review-tasks/review%20task%201/transition'
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
		expect(requestHeader(fetchMock.mock.calls[27][1], 'Idempotency-Key')).toEqual(
			expect.any(String)
		);
	});

	it('sends the observed revision when updating a federation trust source', async () => {
		await adminIdentityMappingAPI.updateFederationTrustSource('source/1', {
			expectedUpdatedAt: 1_788_249_600_000,
			sourceType: 'saml_aggregate',
			sourceKey: 'research-federation',
			displayName: 'Research Federation'
		});

		expect(requestPath(fetchMock.mock.calls[0]?.[0])).toBe(
			'/api/admin/federation/trust-sources/source%2F1'
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			expectedUpdatedAt: 1_788_249_600_000
		});
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
});
