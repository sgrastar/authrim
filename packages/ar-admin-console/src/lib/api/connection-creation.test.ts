import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClients } from './clients';
import { httpSamlProviders } from './saml-providers';
import { emptyAnswers, defaultsForAppType } from '#lib/pages/service-flows/connection-model.js';
import {
	createConnection,
	connectionPath,
	rpCreateInput
} from '#lib/pages/service-flows/connection-creation.js';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'creation-test' } }));
afterEach(() => vi.unstubAllGlobals());
const resources = { clients: httpClients, samlProviders: httpSamlProviders, canCreate: () => true };
const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });

describe('live outgoing creation through HTTP', () => {
	it.each(['web', 'spa', 'native'])(
		'persists %s OIDC semantics and returns one-time credentials',
		async (appType) => {
			if (appType !== 'web' && appType !== 'spa' && appType !== 'native')
				throw new Error('Unknown type');
			const answers = emptyAnswers();
			answers.direction = 'out';
			answers.kind = 'rp';
			Object.assign(answers.rp, {
				name: ' Portal ',
				appType,
				redirectUris: [
					appType === 'native' ? 'com.test.portal:/callback' : 'https://portal.example/callback'
				],
				...defaultsForAppType(appType)
			});
			const fetcher = vi.fn().mockResolvedValue(
				json({
					client: {
						client_id: 'client/a',
						...(appType === 'web' ? { client_secret: 'one-time-test-credential' } : {})
					}
				})
			);
			vi.stubGlobal('fetch', fetcher);
			const result = await createConnection(resources, answers, '');
			const [url, init] = fetcher.mock.calls[0];
			expect(url).toBe('/api/admin/clients');
			expect(init.method).toBe('POST');
			expect(init.credentials).toBe('include');
			expect(init.headers.get('X-Tenant-Id')).toBe('creation-test');
			expect(init.headers.get('Idempotency-Key')).toBeTruthy();
			expect(init.headers.get('Content-Type')).toBe('application/json');
			expect(JSON.parse(init.body)).toEqual({
				client_name: 'Portal',
				application_type: appType,
				redirect_uris: answers.rp.redirectUris,
				grant_types: ['authorization_code'],
				response_types: ['code'],
				scope: 'openid',
				token_endpoint_auth_method: appType === 'web' ? 'client_secret_basic' : 'none',
				require_pkce: true
			});
			expect(result).toEqual({
				kind: 'rp',
				id: 'client/a',
				...(appType === 'web' ? { clientSecret: 'one-time-test-credential' } : {})
			});
			expect(connectionPath(result)).toBe('/admin/applications/all/rp/client%2Fa');
		}
	);
	it('creates a disabled manual SP with real fields and no invented metadata, mapping, certificate or NameID', async () => {
		const answers = emptyAnswers();
		answers.direction = 'out';
		answers.kind = 'sp';
		Object.assign(answers.sp, {
			importMode: 'manual',
			entityId: 'urn:test:service',
			acsUrl: 'https://service.example/acs'
		});
		const fetcher = vi.fn().mockResolvedValue(json({ id: 'sp/a' }));
		vi.stubGlobal('fetch', fetcher);
		const result = await createConnection(resources, answers, ' Service ');
		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0];
		expect(url).toBe('/api/admin/saml-providers');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('include');
		expect(init.headers.get('X-Tenant-Id')).toBe('creation-test');
		expect(JSON.parse(init.body)).toEqual({
			name: 'Service',
			providerType: 'saml_sp',
			enabled: false,
			config: {
				entityId: 'urn:test:service',
				acsUrl: 'https://service.example/acs',
				allowedBindings: ['post'],
				signAssertions: true,
				signResponses: true
			}
		});
		expect(connectionPath(result)).toBe('/admin/applications/all/sp/sp%2Fa');
	});
	it('propagates API errors and retries the actual POST with unchanged answers', async () => {
		const answers = emptyAnswers();
		answers.direction = 'out';
		answers.kind = 'rp';
		Object.assign(answers.rp, {
			name: 'Portal',
			redirectUris: ['https://portal.example/callback']
		});
		const before = structuredClone(answers);
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({ error: 'invalid_request', error_description: 'Redirect refused' }, 400)
			)
			.mockResolvedValueOnce(
				json({ client: { client_id: 'saved', client_secret: 'test-credential' } })
			);
		vi.stubGlobal('fetch', fetcher);
		await expect(createConnection(resources, answers, '')).rejects.toThrow('Redirect refused');
		expect(answers).toEqual(before);
		await expect(createConnection(resources, answers, '')).resolves.toMatchObject({ id: 'saved' });
		expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
	});
	it('rejects incomplete redirects, unsupported JWT auth and public clients without PKCE before any write', () => {
		const form = emptyAnswers().rp;
		form.name = 'Portal';
		expect(() => rpCreateInput(form)).toThrow();
		form.redirectUris = ['https://portal.example/callback#fragment'];
		expect(() => rpCreateInput(form)).toThrow();
		form.redirectUris = ['https://portal.example/callback'];
		form.authMethod = 'private_key_jwt';
		expect(() => rpCreateInput(form)).toThrow();
		form.appType = 'spa';
		Object.assign(form, defaultsForAppType('spa'));
		form.pkce = false;
		expect(() => rpCreateInput(form)).toThrow();
	});
	it('never writes unavailable inbound clients, metadata imports, missing ACS or denied resources', async () => {
		const fetcher = vi.fn();
		vi.stubGlobal('fetch', fetcher);
		const answers = emptyAnswers();
		answers.direction = 'in';
		answers.kind = 'op';
		await expect(createConnection(resources, answers, '')).rejects.toThrow();
		answers.direction = 'out';
		answers.kind = 'sp';
		answers.sp.metadataUrl = 'https://service.example/metadata';
		answers.sp.fetched = true;
		await expect(createConnection(resources, answers, 'Service')).rejects.toThrow();
		answers.sp.importMode = 'manual';
		answers.sp.entityId = 'urn:test:service';
		await expect(createConnection(resources, answers, 'Service')).rejects.toThrow();
		answers.sp.acsUrl = 'https://service.example/acs';
		await expect(
			createConnection({ ...resources, canCreate: () => false }, answers, 'Service')
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
});
