import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpExternalProviders } from './external-providers';
import { httpSamlProviders } from './saml-providers';
import { emptyAnswers } from '#lib/pages/service-flows/connection-model.js';
import {
	createConnection,
	opWriteInput,
	idpCreateInput
} from '#lib/pages/service-flows/connection-creation.js';

vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: { tenantId: 'upstream-test' } }));
afterEach(() => vi.unstubAllGlobals());
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const discovery = {
	issuer: 'https://provider.example',
	authorization_endpoint: 'https://provider.example/login',
	token_endpoint: 'https://provider.example/exchange',
	jwks_uri: 'https://provider.example/keys.json'
};
const oidcRow = {
	id: 'oidc/provider',
	updatedAt: 42,
	priority: 17,
	providerType: 'oidc',
	name: 'Directory',
	issuer: discovery.issuer,
	clientId: 'registered-client',
	hasSecret: true,
	scopes: 'openid email',
	enabled: false,
	autoLinkEmail: false,
	requireEmailVerified: true,
	trustEmail: false,
	jitProvisioning: false
};
const certificate =
	'-----BEGIN CERTIFICATE-----\nVEVTVCBDRVJUSUZJQ0FURQ==\n-----END CERTIFICATE-----';
const samlRow = {
	id: 'saml/provider',
	providerType: 'saml_idp',
	name: 'Identity provider',
	enabled: false,
	updatedAt: '2026-11-16T00:00:00Z',
	config: { entityId: 'urn:test:idp', ssoUrl: 'https://idp.example/sso', certificate }
};
const resources = {
	clients: { create: vi.fn() },
	samlProviders: { createServiceProvider: vi.fn() },
	externalProviders: httpExternalProviders,
	samlIdentityProviders: httpSamlProviders,
	canCreate: () => true
};

describe('upstream provider HTTP contracts', () => {
	it('discovers through the Admin API then creates, reopens and lists an OIDC provider without reading a saved secret', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json(discovery))
			.mockResolvedValueOnce(json(oidcRow, 201))
			.mockResolvedValueOnce(
				json({
					...oidcRow,
					client_secret: 'must-not-read',
					clientSecretEncrypted: 'must-not-read',
					unknownExtension: 'must-not-project'
				})
			)
			.mockResolvedValueOnce(
				json({ providers: [oidcRow, { ...oidcRow, id: 'oauth2', providerType: 'oauth2' }] })
			);
		vi.stubGlobal('fetch', fetcher);
		const answers = emptyAnswers();
		answers.kind = 'op';
		answers.direction = 'in';
		const result = await httpExternalProviders.discover(discovery.issuer);
		Object.assign(answers.op, {
			name: 'Directory',
			issuer: discovery.issuer,
			discovery: result,
			discovered: true,
			clientId: 'registered-client',
			clientSecret: 'entered-secret',
			scopes: 'openid email',
			link: 'manual',
			requireEmailVerified: true,
			trustEmail: false,
			jitProvisioning: false
		});
		await expect(createConnection(resources, answers, '')).resolves.toEqual({
			kind: 'op',
			id: oidcRow.id
		});
		const reopened = await httpExternalProviders.get(oidcRow.id);
		expect(reopened).toEqual({
			id: oidcRow.id,
			updatedAt: 42,
			advanced: {
				authorizationEndpoint: null,
				tokenEndpoint: null,
				userinfoEndpoint: null,
				jwksUri: null,
				tokenEndpointAuthMethod: null,
				alwaysFetchUserinfo: null,
				profileUpdateFields: null,
				enableSso: null,
				buttonText: null,
				buttonColor: null,
				priority: 17
			},
			name: 'Directory',
			issuer: discovery.issuer,
			clientId: 'registered-client',
			hasSecret: true,
			scopes: 'openid email',
			enabled: false,
			autoLinkEmail: false,
			requireEmailVerified: true,
			trustEmail: false,
			jitProvisioning: false
		});
		expect(await httpExternalProviders.list()).toEqual([reopened]);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			'/api/admin/external-providers/discover-oidc',
			'/api/admin/external-providers',
			'/api/admin/external-providers/oidc%2Fprovider',
			'/api/admin/external-providers'
		]);
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ url: discovery.issuer });
		expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
			name: 'Directory',
			provider_type: 'oidc',
			issuer: discovery.issuer,
			client_id: 'registered-client',
			client_secret: 'entered-secret',
			scopes: 'openid email',
			enabled: false,
			auto_link_email: false,
			require_email_verified: true,
			trust_email: false,
			jit_provisioning: false,
			authorization_endpoint: discovery.authorization_endpoint,
			token_endpoint: discovery.token_endpoint,
			jwks_uri: discovery.jwks_uri,
			userinfo_endpoint: ''
		});
		for (const [, init] of fetcher.mock.calls) {
			expect(init.credentials).toBe('include');
			expect(init.headers.get('X-Tenant-Id')).toBe('upstream-test');
		}
		expect(fetcher.mock.calls[1][0]).not.toContain('entered-secret');
	});
	it('updates without replacing a stored secret, and includes an explicitly entered replacement only in the PUT body', async () => {
		const form = emptyAnswers().op;
		Object.assign(form, {
			name: 'Changed',
			issuer: discovery.issuer,
			clientId: 'registered-client',
			scopes: 'openid',
			link: 'manual',
			requireEmailVerified: true,
			trustEmail: false
		});
		const fetcher = vi.fn().mockImplementation(async () => json({ ...oidcRow, name: 'Changed' }));
		vi.stubGlobal('fetch', fetcher);
		await httpExternalProviders.update(oidcRow.id, opWriteInput(form, true));
		expect(fetcher.mock.calls[0][1].method).toBe('PUT');
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).not.toHaveProperty('client_secret');
		form.clientSecret = 'replacement-secret';
		await httpExternalProviders.update(oidcRow.id, opWriteInput(form, true));
		expect(JSON.parse(fetcher.mock.calls[1][1].body).client_secret).toBe('replacement-secret');
		expect(fetcher.mock.calls[1][0]).not.toContain('replacement-secret');
	});
	it('creates a disabled manual SAML IdP, then reads, lists and partially updates its true inbound configuration', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(json(samlRow, 201))
			.mockResolvedValueOnce(
				json({ ...samlRow, config: { ...samlRow.config, unknownExtension: 'must-not-project' } })
			)
			.mockResolvedValueOnce(
				json({ providers: [samlRow, { ...samlRow, providerType: 'saml_sp' }] })
			)
			.mockResolvedValueOnce(json({ ...samlRow, name: 'Changed' }));
		vi.stubGlobal('fetch', fetcher);
		const answers = emptyAnswers();
		answers.direction = 'in';
		answers.kind = 'idp';
		Object.assign(answers.idp, {
			name: 'Identity provider',
			importMode: 'manual',
			entityId: 'urn:test:idp',
			acsUrl: 'https://idp.example/sso',
			certificate
		});
		await expect(createConnection(resources, answers, '')).resolves.toEqual({
			kind: 'idp',
			id: samlRow.id
		});
		const read = await httpSamlProviders.getIdentityProvider(samlRow.id);
		expect(read).toEqual({
			configurationMissing: false,
			id: samlRow.id,
			name: samlRow.name,
			enabled: false,
			hasMapping: false,
			trustBlocked: false,
			updatedAt: samlRow.updatedAt,
			metadataUrl: undefined,
			hasMetadataUrl: false,
			certificateValidation: {},
			config: {},
			...samlRow.config
		});
		expect(await httpSamlProviders.listIdentityProviders()).toEqual([read]);
		await httpSamlProviders.updateIdentityProvider(read.id, {
			name: 'Changed',
			expectedUpdatedAt: read.updatedAt,
			config: samlRow.config
		});
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
			name: samlRow.name,
			providerType: 'saml_idp',
			enabled: false,
			config: {
				...samlRow.config,
				jitEmailLinkingPolicy: 'disabled',
				allowSyntheticEmailFallback: false
			}
		});
		expect(fetcher.mock.calls[1][0]).toBe('/api/admin/saml-providers/saml%2Fprovider');
		expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({
			name: 'Changed',
			expectedUpdatedAt: samlRow.updatedAt,
			config: samlRow.config
		});
		expect(fetcher.mock.calls[3][1].method).toBe('PUT');
	});
	it('requires the manual IdP certificate and rejects discovery failure or stale issuer before writing', async () => {
		const answers = emptyAnswers();
		answers.direction = 'in';
		answers.kind = 'idp';
		Object.assign(answers.idp, {
			name: 'Identity',
			importMode: 'manual',
			entityId: 'urn:test:idp',
			acsUrl: 'https://idp.example/sso'
		});
		expect(() => idpCreateInput(answers.idp)).toThrow();
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				json({ error: 'discovery_failed', error_description: 'Discovery refused' }, 400)
			);
		vi.stubGlobal('fetch', fetcher);
		await expect(httpExternalProviders.discover(discovery.issuer)).rejects.toThrow(
			'Discovery refused'
		);
		answers.kind = 'op';
		Object.assign(answers.op, {
			name: 'Directory',
			issuer: 'https://changed.example',
			discovered: true,
			discovery,
			clientId: 'client',
			clientSecret: 'secret',
			scopes: 'openid'
		});
		await expect(createConnection(resources, answers, '')).rejects.toThrow();
		await expect(
			createConnection({ ...resources, canCreate: () => false }, answers, '')
		).rejects.toThrow();
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('propagates failed updates without mutating the submitted secret or fields', async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(json({ error: 'conflict', error_description: 'Save refused' }, 409));
		vi.stubGlobal('fetch', fetcher);
		const form = emptyAnswers().op;
		Object.assign(form, {
			name: 'Directory',
			issuer: discovery.issuer,
			clientId: 'client',
			clientSecret: 'retry-secret',
			scopes: 'openid'
		});
		const input = opWriteInput(form, true);
		await expect(httpExternalProviders.update(oidcRow.id, input)).rejects.toThrow('Save refused');
		expect(form.clientSecret).toBe('retry-secret');
		expect(input.client_secret).toBe('retry-secret');
	});
});
