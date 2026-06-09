// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adminSAMLAPI } from './admin-saml';

describe('adminSAMLAPI', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it('lists SAML providers with metadata and rollover state', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					providers: [
						{
							id: 'provider-1',
							name: 'Publisher SP',
							providerType: 'saml_sp',
							enabled: true,
							config: {
								entityId: 'https://publisher.example/saml',
								metadataUrl: 'https://publisher.example/metadata.xml',
								metadataRefreshStatus: {
									lastCheckedAt: 1778520000000,
									currentHash: 'abc',
									diff: { changed: false, expired: false }
								},
								signingKeyPolicy: {
									active: { slot: 'active', keyRef: 'tenant:tenant-a:saml:idp:signing' },
									next: { slot: 'next', keyRef: 'tenant:tenant-a:saml:idp:next:signing' }
								}
							},
							createdAt: '2026-05-12T00:00:00.000Z',
							updatedAt: '2026-05-12T00:00:00.000Z'
						}
					]
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		const response = await adminSAMLAPI.listProviders();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/admin/saml-providers');
		expect(response.providers[0]?.config.signingKeyPolicy?.next?.slot).toBe('next');
	});

	it('promotes a next signing certificate with backup retention', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, config: { entityId: 'https://sp.example' } }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminSAMLAPI.promoteSigningNext('provider-1');

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			'/api/admin/saml-providers/provider-1/signing-rollover/promote-next'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			keepPreviousAsBackup: true
		});
	});

	it('creates a SAML provider from metadata input', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					id: 'provider-2',
					name: 'MockSAML',
					providerType: 'saml_idp',
					enabled: true,
					config: { entityId: 'https://mocksaml.example/idp' },
					createdAt: '2026-05-14T00:00:00.000Z',
					updatedAt: '2026-05-14T00:00:00.000Z'
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminSAMLAPI.createProvider({
			name: 'MockSAML',
			providerType: 'saml_idp',
			config: { description: 'Sandbox IdP' },
			metadataUrl: 'https://mocksaml.example/metadata'
		});

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/admin/saml-providers');
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
		const headers = fetchMock.mock.calls[0]?.[1]?.headers;
		expect(headers).toBeInstanceOf(Headers);
		expect((headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			name: 'MockSAML',
			providerType: 'saml_idp',
			config: { description: 'Sandbox IdP' },
			metadataUrl: 'https://mocksaml.example/metadata'
		});
	});

	it('imports metadata for an existing SAML provider', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					config: { entityId: 'https://sp.example/saml' },
					metadataRefreshStatus: {
						lastCheckedAt: 1778520000000,
						currentHash: 'abc',
						diff: { changed: true, expired: false }
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminSAMLAPI.importMetadata('provider-1', {
			metadataXml: '<EntityDescriptor />',
			samlProfile: 'baseline'
		});

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			'/api/admin/saml-providers/provider-1/import-metadata'
		);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			metadataXml: '<EntityDescriptor />',
			samlProfile: 'baseline'
		});
	});

	it('creates a custom SAML attribute preset', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					preset: {
						id: 'custom:preset-1',
						version: 'custom:1778520000000',
						profile: 'custom',
						label: 'Custom SaaS',
						description: 'Tenant-specific SaaS release',
						stability: 'custom',
						applicationMode: 'clone_edit',
						appliesTo: 'sp_attribute_release',
						isCustom: true,
						attributeReleasePolicy: {
							attributes: [{ name: 'urn:oid:mail', source: 'claim', claim: 'email' }]
						}
					}
				}),
				{ status: 201, headers: { 'Content-Type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminSAMLAPI.createAttributePreset({
			label: 'Custom SaaS',
			description: 'Tenant-specific SaaS release',
			appliesTo: 'sp_attribute_release',
			attributeReleasePolicy: {
				attributes: [{ name: 'urn:oid:mail', source: 'claim', claim: 'email' }]
			}
		});

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/admin/saml-attribute-presets');
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			label: 'Custom SaaS',
			appliesTo: 'sp_attribute_release'
		});
	});

	it('deletes a custom SAML attribute preset', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await adminSAMLAPI.deleteAttributePreset('custom:preset-1');

		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			'/api/admin/saml-attribute-presets/custom%3Apreset-1'
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
	});
});
