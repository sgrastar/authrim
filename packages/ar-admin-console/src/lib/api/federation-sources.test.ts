import { afterEach, describe, expect, it, vi } from 'vitest';

const testTenant = vi.hoisted(() => ({ tenantId: 'federation-test' }));
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: testTenant }));

import { ApiError } from './api-error';
import { httpFederationSources } from './federation-sources';

afterEach(() => vi.unstubAllGlobals());

interface Call {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
}
function stub(answer: (call: Call) => Response): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
			const call: Call = {
				url: String(input),
				method: init.method ?? 'GET',
				headers: new Headers(init.headers),
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			};
			calls.push(call);
			return answer(call);
		})
	);
	return calls;
}

describe('the federation sources client', () => {
	it('reads a list item and a single source into the same shape', async () => {
		const row = {
			id: 'f1',
			sourceKey: 'https://m.example/a.xml',
			displayName: 'Fed',
			lifecycleState: 'active',
			protocolPayload: {
				metadataUrl: 'https://m.example/a.xml',
				runtimeResolution: { mode: 'automatic', roles: ['saml_sp'], spFieldMappingSetId: 's1' },
				exceptions: { excludedEntityIds: ['x'] },
				idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example/' }
			},
			createdAt: 1,
			updatedAt: 2
		};
		const status = {
			sourceState: 'expired',
			entityCount: 9,
			excludedCount: 1,
			consecutiveFailures: 2
		};
		stub((call) =>
			Response.json(
				call.url.endsWith('federation-trust-sources')
					? { federationTrustSources: [{ ...row, status }] }
					: { federationTrustSource: row, status }
			)
		);
		const [listed] = await httpFederationSources.list();
		const single = await httpFederationSources.get('f1');
		for (const source of [listed, single]) {
			expect(source).toMatchObject({
				id: 'f1',
				name: 'Fed',
				roles: ['saml_sp'],
				spMappingSetId: 's1',
				excludedEntityIds: ['x'],
				idpSelection: { mode: 'external_ds', discoveryServiceUrl: 'https://ds.example/' },
				status: { sourceState: 'expired', entityCount: 9 }
			});
		}
	});

	it('writes a source as a saml_aggregate trust source, bound to the tenant, once-only', async () => {
		const calls = stub(() => Response.json({ result: { id: 'f2' } }, { status: 201 }));
		const result = await httpFederationSources.create({
			sourceKey: 'k',
			name: 'Fed',
			lifecycleState: 'active',
			payload: { metadataUrl: 'https://m.example/a.xml' }
		});
		expect(result).toEqual({ id: 'f2' });
		expect(calls[0]).toMatchObject({
			method: 'POST',
			body: {
				sourceType: 'saml_aggregate',
				sourceKey: 'k',
				displayName: 'Fed',
				lifecycleState: 'active',
				protocolPayload: { metadataUrl: 'https://m.example/a.xml' }
			}
		});
		expect(calls[0].url).toContain('/api/admin/field-mapping/federation-trust-sources');
		expect(calls[0].headers.get('Idempotency-Key')).toBeTruthy();
		expect(calls[0].headers.get('X-Tenant-Id')).toBe('federation-test');
	});

	it('sends the version read with an update, and leaves a 409 as an ApiError', async () => {
		const calls = stub(() => Response.json({ error: 'conflict' }, { status: 409 }));
		await expect(
			httpFederationSources.update('f1', {
				sourceKey: 'k',
				name: 'Fed',
				lifecycleState: 'active',
				payload: {},
				expectedUpdatedAt: 7
			})
		).rejects.toMatchObject({ status: 409 });
		expect(calls[0].method).toBe('PUT');
		expect((calls[0].body as { expectedUpdatedAt: number }).expectedUpdatedAt).toBe(7);
		await expect(
			httpFederationSources.update('f1', {
				sourceKey: 'k',
				name: 'Fed',
				lifecycleState: 'active',
				payload: {},
				expectedUpdatedAt: 7
			})
		).rejects.toBeInstanceOf(ApiError);
	});

	it('asks for entities with the search, role, state and page in the query', async () => {
		const calls = stub(() =>
			Response.json({
				items: [
					{
						entityId: 'e',
						role: 'saml_idp',
						explicitProviderId: 'p',
						explicitProviderType: 'saml_idp'
					}
				],
				nextCursor: '50',
				total: 120
			})
		);
		const page = await httpFederationSources.entities('f 1', {
			q: 'lib',
			role: 'saml_idp',
			state: 'explicit',
			limit: 20,
			cursor: '40'
		});
		const url = new URL(calls[0].url, 'https://x.example');
		expect(url.pathname).toBe('/api/admin/field-mapping/federation-trust-sources/f%201/entities');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: 'lib',
			role: 'saml_idp',
			state: 'explicit',
			limit: '20',
			cursor: '40'
		});
		expect(page).toMatchObject({ nextCursor: '50', total: 120 });
		// The server's provider types are the console's kinds.
		expect(page.items[0].explicitProviderType).toBe('idp');
	});

	it('refreshes and materializes through the SAML routes, with the server’s type names', async () => {
		const calls = stub((call) =>
			Response.json(
				call.url.endsWith('refresh-metadata')
					? { success: true, changed: true, entityCount: 4, verificationStatus: 'verified' }
					: { providerId: 'p1', providerType: 'saml_idp' }
			)
		);
		expect(await httpFederationSources.refresh('f1')).toMatchObject({
			entityCount: 4,
			verificationStatus: 'verified'
		});
		expect(
			await httpFederationSources.materialize('f1', {
				entityId: 'e',
				providerType: 'idp',
				enabled: false
			})
		).toEqual({ providerId: 'p1', providerType: 'idp' });
		expect(calls[0].url).toContain('/api/admin/saml-federation-sources/f1/refresh-metadata');
		expect(calls[1].url).toContain('/api/admin/saml-federation-sources/f1/entities/materialize');
		expect(calls[1].body).toMatchObject({
			entityId: 'e',
			providerType: 'saml_idp',
			enabled: false
		});
	});

	it('reads the health of a source from its polling state while the server sends no status', async () => {
		stub(() =>
			Response.json({
				federationTrustSources: [
					{
						id: 'f3',
						sourceKey: 'k',
						displayName: 'Fed',
						lifecycleState: 'active',
						protocolPayload: {
							polling: {
								mode: 'automatic',
								intervalSeconds: 21600,
								sourceState: 'error',
								consecutiveFailures: 3,
								lastSuccessAt: 1_790_000_000_000,
								lastErrorCode: 'metadata_fetch_failed'
							}
						},
						createdAt: 1_790_000_000_000,
						updatedAt: 1_790_000_000_001
					}
				]
			})
		);
		const [source] = await httpFederationSources.list();
		expect(source.status).toMatchObject({
			sourceState: 'degraded',
			consecutiveFailures: 3,
			lastSuccessAt: 1_790_000_000_000,
			lastErrorCode: 'metadata_fetch_failed',
			// Not known without the server's status: not shown as zero.
			entityCount: null
		});
		expect(source.createdAt).toBe(1_790_000_000_000);
	});
});
