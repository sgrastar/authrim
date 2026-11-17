import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClients } from './clients';
import { httpSamlProviders } from './saml-providers';
import {
	basicSettingsAnswers,
	clientBasicUpdate
} from '#lib/pages/service-flows/connection-basic-settings.js';
import { connectionMappingFixture } from '#lib/pages/service-flows/connection-mapping.fixture.js';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'demo' } }));
afterEach(() => vi.unstubAllGlobals());
const client = {
	client_id: 'client/a',
	client_name: 'Portal',
	application_type: 'native',
	redirect_uris: ['https://portal.example/callback'],
	token_endpoint_auth_method: 'none',
	require_pkce: 1,
	identity_mapping: { fieldMappingSetId: 'set-portal', extension: 'keep' },
	jwks: { keys: [] },
	custom_extension: { policy: 'keep' }
};
const provider = {
	id: 'provider/a',
	name: 'Service',
	providerType: 'saml_sp',
	enabled: false,
	updatedAt: '2026-11-16T00:00:00.000Z',
	config: {
		entityId: 'urn:test:sp',
		acsUrl: 'https://service.example/acs',
		signAssertions: true,
		metadataUrl: 'https://service.example/metadata',
		identityMapping: {
			fieldMappingSetId: 'set-portal',
			destinationFieldPolicies: { email: 'hidden' }
		},
		custom_extension: { policy: 'keep' }
	}
};

describe('basic connection settings over HTTP', () => {
	it('gets RP by its encoded ID, updates only intended fields, and uses actual saved values on reopen', async () => {
		let row = { ...client };
		const writes: RequestInit[] = [];
		const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
			expect(url).toBe('/api/admin/clients/client%2Fa');
			if (init.method === 'PUT') {
				writes.push(init);
				expect(JSON.parse(String(init.body))).toEqual({
					client_name: 'Changed portal',
					redirect_uris: ['https://portal.example/new']
				});
				row = {
					...row,
					client_name: 'Changed portal',
					redirect_uris: ['https://portal.example/new']
				};
			}
			return Response.json({ client: row });
		});
		vi.stubGlobal('fetch', fetcher);
		const loaded = await httpClients.get(client.client_id);
		expect(loaded).toMatchObject({ applicationType: 'native', authMethod: 'none', pkce: true });
		const answers = basicSettingsAnswers({ kind: 'rp', detail: loaded, client: httpClients });
		answers.rp.name = 'Changed portal';
		answers.rp.redirectUris = ['https://portal.example/new'];
		const saved = await httpClients.updateBasics(loaded.id, clientBasicUpdate(loaded, answers));
		expect(saved.name).toBe('Changed portal');
		expect(await httpClients.get(loaded.id)).toEqual(saved);
		expect(row.identity_mapping).toEqual(client.identity_mapping);
		expect(row.custom_extension).toEqual(client.custom_extension);
		expect(row.jwks).toEqual(client.jwks);
		expect(writes).toHaveLength(1);
		expect(writes[0].credentials).toBe('include');
		expect(new Headers(writes[0].headers).get('X-Tenant-Id')).toBe('demo');
	});

	it('loads an unnamed registered client by ID and preserves its stored null name during redirect/auth edits', async () => {
		let row = { ...client, client_name: null, token_endpoint_auth_method: 'client_secret_basic' };
		const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
			expect(url).toBe('/api/admin/clients/client%2Fa');
			if (init.method === 'PUT') {
				expect(JSON.parse(String(init.body))).toEqual({
					redirect_uris: ['https://portal.example/updated'],
					token_endpoint_auth_method: 'client_secret_post'
				});
				row = {
					...row,
					redirect_uris: ['https://portal.example/updated'],
					token_endpoint_auth_method: 'client_secret_post'
				};
			}
			return Response.json({ client: row });
		});
		vi.stubGlobal('fetch', fetcher);
		const loaded = await httpClients.get(client.client_id);
		expect(loaded.name).toBe(client.client_id);
		const answers = basicSettingsAnswers({ kind: 'rp', detail: loaded, client: httpClients });
		expect(answers.rp.name).toBe(client.client_id);
		answers.rp.redirectUris = ['https://portal.example/updated'];
		answers.rp.authMethod = 'client_secret_post';
		const saved = await httpClients.updateBasics(loaded.id, clientBasicUpdate(loaded, answers));
		expect(saved).toEqual({
			...loaded,
			redirectUris: ['https://portal.example/updated'],
			authMethod: 'client_secret_post'
		});
		expect(await httpClients.get(loaded.id)).toEqual(saved);
		expect(row.client_name).toBeNull();
		expect(row.identity_mapping).toEqual(client.identity_mapping);
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it.each(['private_key_jwt', 'future_auth', null])(
		'preserves stored %s authentication while allowing independent name edits',
		async (method) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(async () =>
					Response.json({
						client: {
							...client,
							token_endpoint_auth_method: method,
							require_pkce: null,
							application_type: 'service'
						}
					})
				)
			);
			const loaded = await httpClients.get('client/a');
			const answers = basicSettingsAnswers({ kind: 'rp', detail: loaded, client: httpClients });
			expect(loaded).toMatchObject({ authMethod: method, pkce: null, applicationType: 'service' });
			answers.rp.name = 'Renamed';
			expect(clientBasicUpdate(loaded, answers)).toEqual({ client_name: 'Renamed' });
			answers.rp.authMethod = 'client_secret_basic';
			expect(() => clientBasicUpdate(loaded, answers)).toThrow('Unsupported credential transition');
		}
	);

	it('allows only basic/post secret reuse and keeps public PKCE required', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					client: {
						...client,
						token_endpoint_auth_method: 'client_secret_basic',
						require_pkce: false
					}
				})
			)
		);
		const loaded = await httpClients.get('client/a');
		const answers = basicSettingsAnswers({ kind: 'rp', detail: loaded, client: httpClients });
		answers.rp.authMethod = 'client_secret_post';
		answers.rp.pkce = true;
		expect(clientBasicUpdate(loaded, answers)).toEqual({
			token_endpoint_auth_method: 'client_secret_post',
			require_pkce: true
		});
		answers.rp.authMethod = 'none';
		expect(() => clientBasicUpdate(loaded, answers)).toThrow();
		const publicClient = { ...loaded, authMethod: 'none', pkce: true };
		const publicAnswers = basicSettingsAnswers({
			kind: 'rp',
			detail: publicClient,
			client: httpClients
		});
		publicAnswers.rp.pkce = false;
		expect(() => clientBasicUpdate(publicClient, publicAnswers)).toThrow(
			'Public clients require PKCE'
		);
	});

	it('SP settings use the loaded version and a partial config, then return/reload the server values', async () => {
		const updatedAt = '2026-11-17T00:00:00.000Z';
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(provider))
			.mockResolvedValueOnce(
				Response.json({
					...provider,
					name: 'Renamed',
					updatedAt,
					config: { ...provider.config, acsUrl: 'https://service.example/new' }
				})
			)
			.mockResolvedValueOnce(
				Response.json({
					...provider,
					name: 'Renamed',
					updatedAt,
					config: { ...provider.config, acsUrl: 'https://service.example/new' }
				})
			);
		vi.stubGlobal('fetch', fetcher);
		const loaded = await httpSamlProviders.getServiceProvider(provider.id);
		const saved = await httpSamlProviders.updateServiceProvider(provider.id, {
			name: 'Renamed',
			expectedUpdatedAt: loaded.updatedAt,
			config: { acsUrl: 'https://service.example/new' }
		});
		expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
			name: 'Renamed',
			expectedUpdatedAt: provider.updatedAt,
			config: { acsUrl: 'https://service.example/new' }
		});
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
			Array(2).fill('/api/admin/saml-providers/provider%2Fa')
		);
		expect(await httpSamlProviders.getServiceProvider(provider.id)).toEqual(saved);
		expect(saved).toMatchObject({
			name: 'Renamed',
			acsUrl: 'https://service.example/new',
			updatedAt
		});
	});

	it('does not fresh-get before an optimistic settings update, or retry a conflict', async () => {
		const fetcher = vi.fn(async () => Response.json({ error: 'conflict' }, { status: 409 }));
		vi.stubGlobal('fetch', fetcher);
		await expect(
			httpSamlProviders.updateServiceProvider(provider.id, {
				name: 'Draft',
				expectedUpdatedAt: provider.updatedAt
			})
		).rejects.toMatchObject({ status: 409 });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0]).toEqual(
			expect.arrayContaining(['/api/admin/saml-providers/provider%2Fa'])
		);
	});

	it.each(['saml_sp', 'saml_idp'])(
		'disables %s with only enabled and version even without a mapping',
		async (providerType) => {
			const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => {
				expect(JSON.parse(String(init.body))).toEqual({
					enabled: false,
					expectedUpdatedAt: provider.updatedAt
				});
				expect(init.method).toBe('PUT');
				return Response.json({
					...provider,
					providerType,
					enabled: false,
					config: { ...provider.config, identityMapping: null }
				});
			});
			vi.stubGlobal('fetch', fetcher);
			const result = await httpSamlProviders.setEnabled(provider.id, {
				enabled: false,
				expectedUpdatedAt: provider.updatedAt
			});
			expect(result.enabled).toBe(false);
			expect(result.hasMapping).toBe(false);
			expect(fetcher).toHaveBeenCalledTimes(1);
		}
	);

	it('reports actual disabled status after the backend refuses an expired-certificate activation', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({
					...provider,
					config: { ...provider.config, certificateValidation: { allExpired: true } }
				})
			)
		);
		expect(
			await httpSamlProviders.setEnabled(provider.id, {
				enabled: true,
				expectedUpdatedAt: provider.updatedAt
			})
		).toMatchObject({ enabled: false, trustBlocked: true });
	});

	it('binds an SP mapping then enables using the current persisted provider version', async () => {
		const version = '2026-11-17T00:00:00.000Z';
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(provider))
			.mockResolvedValueOnce(Response.json({ ...provider, updatedAt: version }))
			.mockResolvedValueOnce(Response.json({ ...provider, updatedAt: version }))
			.mockResolvedValueOnce(Response.json({ ...provider, updatedAt: version, enabled: true }));
		vi.stubGlobal('fetch', fetcher);
		await httpSamlProviders.bindMapping(
			provider.id,
			connectionMappingFixture('shared', 'saml').initial,
			'bind-key'
		);
		const current = await httpSamlProviders.getServiceProvider(provider.id);
		const result = await httpSamlProviders.setEnabled(provider.id, {
			enabled: true,
			expectedUpdatedAt: current.updatedAt
		});
		expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({
			enabled: true,
			expectedUpdatedAt: version
		});
		expect(result.enabled).toBe(true);
		expect(new Headers(fetcher.mock.calls[1][1].headers).get('Idempotency-Key')).toBe('bind-key');
	});
});
