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
});
