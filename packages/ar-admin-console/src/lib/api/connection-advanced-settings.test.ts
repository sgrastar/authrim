import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpClients } from './clients';
import { httpSamlProviders } from './saml-providers';
import { httpExternalProviders } from './external-providers';
import {
	basicSettingsAnswers,
	clientBasicUpdate
} from '#lib/pages/service-flows/connection-basic-settings.js';
import {
	advancedPatch,
	readAdvanced,
	RP_FIELDS,
	SP_FIELDS,
	OP_FIELDS,
	IDP_FIELDS,
	record
} from '#lib/pages/service-flows/advanced-settings.js';
import { rpCreateInput } from '#lib/pages/service-flows/connection-creation.js';
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({
	tenantScope: { tenantId: 'fixture-tenant' }
}));
afterEach(() => vi.unstubAllGlobals());

async function publicJwks() {
	const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify'
	]);
	return {
		keys: [
			{
				...(await crypto.subtle.exportKey('jwk', keys.publicKey)),
				kid: 'generated-fixture',
				alg: 'ES256',
				use: 'sig'
			}
		]
	};
}

describe('live connection advanced HTTP contracts', () => {
	it('reopens nondefault RP values and writes only edited fields with the loaded version', async () => {
		let row: Record<string, unknown> = {
			client_id: 'rp',
			client_name: 'Fixture',
			redirect_uris: ['https://app.example.test/cb'],
			application_type: 'web',
			token_endpoint_auth_method: 'client_secret_basic',
			require_pkce: true,
			updated_at: 1000,
			contacts: ['team@example.test'],
			grant_types: ['authorization_code'],
			id_token_signed_response_alg: 'PS256',
			token_exchange_allowed: true,
			default_audience: 'https://api.example.test',
			identity_mapping: { fieldMappingSetId: 'keep' },
			extension: { keep: true }
		};
		const fetcher = vi.fn(async (_url: string, init: RequestInit = {}) => {
			if (init.method === 'PUT') {
				const body: unknown = JSON.parse(String(init.body));
				expect(body).toEqual({
					expected_updated_at: 1000,
					default_audience: 'https://next.example.test'
				});
				row = { ...row, ...record(body), updated_at: 1001 };
			}
			return Response.json({ client: row });
		});
		vi.stubGlobal('fetch', fetcher);
		const detail = await httpClients.get('rp');
		const draft = basicSettingsAnswers({ kind: 'rp', detail, client: httpClients });
		expect(draft.advanced).toMatchObject({
			id_token_signed_response_alg: 'PS256',
			token_exchange_allowed: true,
			contacts: ['team@example.test']
		});
		draft.advanced.default_audience = 'https://next.example.test';
		await httpClients.updateBasics('rp', {
			...clientBasicUpdate(detail, draft),
			advanced: advancedPatch(detail.advanced, draft.advanced, RP_FIELDS)
		});
		const reopened = basicSettingsAnswers({
			kind: 'rp',
			detail: await httpClients.get('rp'),
			client: httpClients
		});
		expect(reopened.advanced.default_audience).toBe('https://next.example.test');
		expect(row.identity_mapping).toEqual({ fieldMappingSetId: 'keep' });
		expect(row.extension).toEqual({ keep: true });
	});

	it('creates key-auth clients with public material and switches URI to inline JWKS atomically', async () => {
		const jwks = await publicJwks();
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit = {}) => {
				if (init.method === 'PUT')
					expect(JSON.parse(String(init.body))).toEqual({
						jwks,
						jwks_uri: null,
						expected_updated_at: 1000
					});
				return Response.json({
					client: {
						client_id: 'rp',
						client_name: 'Fixture',
						redirect_uris: ['https://app.example.test/cb'],
						application_type: 'web',
						token_endpoint_auth_method: 'private_key_jwt',
						require_pkce: true,
						updated_at: 1000,
						...(init.method === 'PUT'
							? { jwks, jwks_uri: null }
							: { jwks_uri: 'https://keys.example.test/jwks' })
					}
				});
			})
		);
		const detail = await httpClients.get('rp');
		const draft = basicSettingsAnswers({ kind: 'rp', detail, client: httpClients });
		draft.rp.keySource = 'inline';
		draft.rp.publicJwks = JSON.stringify(jwks);
		const updated = await httpClients.updateBasics('rp', clientBasicUpdate(detail, draft));
		expect(updated.jwks).toEqual(jwks);
		expect(rpCreateInput(draft.rp)).toMatchObject({
			token_endpoint_auth_method: 'private_key_jwt',
			jwks_uri: null,
			jwks
		});
		draft.rp.publicJwks = JSON.stringify({ keys: [{ ...jwks.keys[0], d: 'synthetic-private' }] });
		expect(() => clientBasicUpdate(detail, draft)).toThrow('Private');
		draft.rp.appType = 'spa';
		expect(() => rpCreateInput(draft.rp)).toThrow();
	});

	it('preserves nested SAML policy extensions and keeps certificates and mapping out of partial updates', async () => {
		const config = {
			entityId: 'urn:fixture:sp',
			acsUrl: 'https://sp.example.test/acs',
			assertionValiditySeconds: 480,
			signResponses: false,
			signAssertions: true,
			metadataUrl: 'https://sp.example.test/metadata',
			metadataRefreshPolicy: {
				mode: 'manual',
				intervalSeconds: 3600,
				sourceState: 'healthy',
				extension: 'preserve'
			},
			certificate: 'synthetic-public-certificate',
			identityMapping: { fieldMappingSetId: 'keep' }
		};
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit = {}) => {
				const patch =
					init.method === 'PUT' ? record(record(JSON.parse(String(init.body))).config) : {};
				if (init.method === 'PUT')
					expect(patch).toEqual({
						assertionValiditySeconds: 600,
						metadataRefreshPolicy: { ...config.metadataRefreshPolicy, intervalSeconds: 7200 }
					});
				return Response.json({
					id: 'sp',
					name: 'Fixture',
					providerType: 'saml_sp',
					enabled: false,
					updatedAt: '2026-11-17T00:00:00.000Z',
					config: { ...config, ...patch }
				});
			})
		);
		const loaded = await httpSamlProviders.getServiceProvider('sp');
		const values = readAdvanced(loaded.config, SP_FIELDS);
		expect(values.signResponses).toBe(false);
		values.assertionValiditySeconds = 600;
		values['metadataRefreshPolicy.intervalSeconds'] = 7200;
		const result = await httpSamlProviders.updateServiceProvider('sp', {
			expectedUpdatedAt: loaded.updatedAt,
			config: advancedPatch(loaded.config, values, SP_FIELDS)
		});
		expect(result.config?.assertionValiditySeconds).toBe(600);
		expect(result.config).not.toHaveProperty('identityMapping');
		expect(result.config).not.toHaveProperty('certificate');
	});

	it('projects upstream public options and writes their real snake_case contract and version', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: string, init: RequestInit = {}) => {
				if (init.method === 'PUT')
					expect(JSON.parse(String(init.body))).toEqual({
						expected_updated_at: 42,
						name: 'Upstream',
						issuer: 'https://op.example.test',
						client_id: 'rp',
						scopes: 'openid',
						auto_link_email: false,
						jit_provisioning: true,
						require_email_verified: true,
						trust_email: false,
						token_endpoint_auth_method: 'client_secret_basic',
						priority: 17
					});
				return Response.json({
					id: 'op',
					providerType: 'oidc',
					name: 'Upstream',
					issuer: 'https://op.example.test',
					clientId: 'rp',
					scopes: 'openid',
					hasSecret: true,
					updatedAt: 42,
					tokenEndpointAuthMethod:
						init.method === 'PUT' ? 'client_secret_basic' : 'client_secret_post',
					priority: init.method === 'PUT' ? 17 : 8,
					profileUpdateFields: ['picture'],
					alwaysFetchUserinfo: true,
					clientSecretEncrypted: 'must-never-enter-draft'
				});
			})
		);
		const loaded = await httpExternalProviders.get('op');
		const values = readAdvanced(loaded.advanced, OP_FIELDS);
		expect(values.profileUpdateFields).toEqual(['picture']);
		values.tokenEndpointAuthMethod = 'client_secret_basic';
		values.priority = 17;
		const result = await httpExternalProviders.update('op', {
			expected_updated_at: loaded.updatedAt,
			name: loaded.name,
			issuer: loaded.issuer,
			client_id: loaded.clientId,
			scopes: loaded.scopes,
			auto_link_email: false,
			jit_provisioning: true,
			require_email_verified: true,
			trust_email: false,
			advanced: advancedPatch(loaded.advanced, values, OP_FIELDS)
		});
		expect(result.advanced?.priority).toBe(17);
		expect(JSON.stringify(loaded)).not.toContain('must-never-enter-draft');
	});

	it('leaves missing and unknown SAML values untouched on unrelated edits', () => {
		const config = {
			providerName: 'Stored',
			authnContextPolicy: { mode: 'observe', future: 'preserve' },
			future: true
		};
		const values = readAdvanced(config, IDP_FIELDS);
		expect(values.allowedBindings).toBeNull();
		values.providerName = 'Changed';
		expect(advancedPatch(config, values, IDP_FIELDS)).toEqual({ providerName: 'Changed' });
		values['authnContextPolicy.mode'] = 'require_any';
		values['authnContextPolicy.allowedClassRefs'] = ['urn:fixture:acr'];
		expect(advancedPatch(config, values, IDP_FIELDS)).toEqual({
			providerName: 'Changed',
			authnContextPolicy: {
				mode: 'require_any',
				future: 'preserve',
				allowedClassRefs: ['urn:fixture:acr']
			}
		});
	});
});
