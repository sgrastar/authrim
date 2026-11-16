import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClients } from './clients';
import { httpSamlProviders } from './saml-providers';
import { connectionMappingFixture } from '#lib/pages/service-flows/connection-mapping.fixture.js';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'demo' } }));
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown) => new Response(JSON.stringify(body));

describe('connection binding HTTP updates', () => {
	it('updates only the OIDC mapping choice and retains its supported selector settings', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({
					client: {
						identity_mapping: {
							fieldMappingSetId: 'old',
							destinationNamespace: 'oidc.claim',
							sourceProfileId: 'source'
						},
						unrelated: 'keep'
					}
				})
			)
			.mockResolvedValueOnce(json({ success: true }));
		vi.stubGlobal('fetch', fetcher);
		await httpClients.bindMapping('client/a', 'new', 'binding-operation');
		const [url, init] = fetcher.mock.calls[1];
		expect(url).toBe('/api/admin/clients/client%2Fa');
		expect(JSON.parse(init.body)).toEqual({
			identity_mapping: {
				fieldMappingSetId: 'new',
				destinationNamespace: 'oidc.claim',
				sourceProfileId: 'source'
			}
		});
		expect(init.credentials).toBe('include');
		expect(init.headers.get('Idempotency-Key')).toBe('binding-operation');
	});
	it('uses facade fields for exact SAML policy coverage, keeps existing policies and unrelated settings', async () => {
		const fixture = connectionMappingFixture('shared', 'saml');
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({
					updatedAt: '2026-11-16T00:00:00Z',
					config: {
						unrelated: true,
						identityMapping: {
							fieldMappingSetId: 'old',
							destinationProfileId: 'legacy',
							attributeDescriptors: { email: { name: 'email' } },
							destinationFieldPolicies: { email: 'hidden', obsolete: 'optional' }
						}
					}
				})
			)
			.mockResolvedValueOnce(json({ id: 'provider' }));
		vi.stubGlobal('fetch', fetcher);
		await httpSamlProviders.bindMapping('provider', fixture.initial, 'saml-binding-operation');
		expect(fetcher.mock.calls[1][1].headers.get('Idempotency-Key')).toBe('saml-binding-operation');
		const body = JSON.parse(fetcher.mock.calls[1][1].body);
		expect(body).toEqual({
			expectedUpdatedAt: '2026-11-16T00:00:00Z',
			config: {
				identityMapping: {
					fieldMappingSetId: 'set-portal',
					destinationNamespace: 'saml.attribute',
					attributeDescriptors: { email: { name: 'email' } },
					destinationFieldPolicies: { email: 'hidden', name: 'optional' }
				}
			}
		});
	});
});
