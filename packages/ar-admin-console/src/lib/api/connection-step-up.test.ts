import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
	startAuthentication: vi.fn(async () => ({ id: 'test-credential' })),
	WebAuthnAbortService: { cancelCeremony: vi.fn() }
}));
const testTenant = vi.hoisted(() => ({ tenantId: 'connection-test' }));
vi.mock('#lib/auth/tenant-scope.svelte.js', () => ({ tenantScope: testTenant }));

import { startAuthentication } from '@simplewebauthn/browser';
import { setStepUpPrompt, StepUpCancelledError } from './admin-step-up';
import {
	httpSamlProviders,
	httpSamlMetadata,
	type CreateIdentityProviderInput,
	type CreateServiceProviderInput
} from './saml-providers';
import { httpExternalProviders, type ExternalProviderCreate } from './external-providers';
import { emptyAnswers } from '#lib/pages/service-flows/connection-model.js';
import { createConnection } from '#lib/pages/service-flows/connection-creation.js';
import { connectionMappingFixture } from '#lib/pages/service-flows/connection-mapping.fixture.js';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
const json = (body: unknown, status = 200) => Response.json(body, { status });
const certificate = '-----BEGIN CERTIFICATE-----\nVEVTVA==\n-----END CERTIFICATE-----';
const sp = {
	name: 'Service',
	providerType: 'saml_sp',
	enabled: false,
	config: {
		entityId: 'urn:test:sp',
		acsUrl: 'https://service.example/acs',
		allowedBindings: ['post'],
		signAssertions: true,
		signResponses: true
	}
} satisfies CreateServiceProviderInput;
const idp = {
	name: 'Identity',
	providerType: 'saml_idp',
	enabled: false,
	config: {
		entityId: 'urn:test:idp',
		ssoUrl: 'https://identity.example/sso',
		certificate,
		jitEmailLinkingPolicy: 'disabled',
		allowSyntheticEmailFallback: false
	}
} satisfies CreateIdentityProviderInput;
const oidc: ExternalProviderCreate = {
	name: 'Directory',
	provider_type: 'oidc',
	issuer: 'https://directory.example',
	client_id: 'registered-client',
	client_secret: 'test-input-secret',
	scopes: 'openid',
	auto_link_email: false,
	require_email_verified: true,
	trust_email: false,
	jit_provisioning: false,
	enabled: false
};
const samlRow = {
	id: 'provider',
	name: idp.name,
	providerType: 'saml_idp',
	enabled: false,
	updatedAt: '2026-11-16T00:00:00Z',
	config: idp.config
};
const oidcRow = {
	id: 'provider',
	name: oidc.name,
	providerType: 'oidc',
	issuer: oidc.issuer,
	hasSecret: true,
	clientId: oidc.client_id,
	scopes: oidc.scopes,
	enabled: false
};

interface Mutation {
	name: string;
	path: string;
	method: 'POST' | 'PUT';
	success: unknown;
	run: () => Promise<unknown>;
}
const mutations: Mutation[] = [
	{
		name: 'SAML SP create',
		path: '/api/admin/saml-providers',
		method: 'POST',
		success: { id: 'provider' },
		run: () => httpSamlProviders.createServiceProvider(sp)
	},
	{
		name: 'SAML metadata import',
		path: '/api/admin/saml-providers/provider/import-metadata',
		method: 'POST',
		success: {
			success: true,
			providerType: 'saml_sp',
			updatedAt: samlRow.updatedAt,
			config: sp.config,
			enabled: false
		},
		run: () =>
			httpSamlMetadata.importMetadata('provider', {
				expectedUpdatedAt: samlRow.updatedAt,
				metadataXml: '<synthetic-metadata/>'
			})
	},
	{
		name: 'SAML IdP create',
		path: '/api/admin/saml-providers',
		method: 'POST',
		success: { id: 'provider' },
		run: () => httpSamlProviders.createIdentityProvider(idp)
	},
	{
		name: 'SAML IdP update',
		path: '/api/admin/saml-providers/provider',
		method: 'PUT',
		success: samlRow,
		run: () =>
			httpSamlProviders.updateIdentityProvider('provider', {
				name: idp.name,
				expectedUpdatedAt: samlRow.updatedAt,
				config: idp.config
			})
	},
	{
		name: 'SAML SP basic settings',
		path: '/api/admin/saml-providers/provider',
		method: 'PUT',
		success: { ...samlRow, providerType: 'saml_sp', config: sp.config },
		run: () =>
			httpSamlProviders.updateServiceProvider('provider', {
				name: 'Changed service',
				expectedUpdatedAt: samlRow.updatedAt,
				config: { acsUrl: sp.config.acsUrl }
			})
	},
	...['SAML SP enable', 'SAML IdP enable'].map(
		(name): Mutation => ({
			name,
			path: '/api/admin/saml-providers/provider',
			method: 'PUT',
			success: { ...samlRow, enabled: true },
			run: () =>
				httpSamlProviders.setEnabled('provider', {
					enabled: true,
					expectedUpdatedAt: samlRow.updatedAt
				})
		})
	),
	{
		name: 'OIDC OP create',
		path: '/api/admin/external-providers',
		method: 'POST',
		success: oidcRow,
		run: () => httpExternalProviders.create(oidc)
	},
	{
		name: 'OIDC OP update',
		path: '/api/admin/external-providers/provider',
		method: 'PUT',
		success: oidcRow,
		run: () => httpExternalProviders.update('provider', oidc)
	},
	{
		name: 'SAML mapping save',
		path: '/api/admin/saml-providers/provider',
		method: 'PUT',
		success: {},
		run: () =>
			httpSamlProviders.bindMapping(
				'provider',
				connectionMappingFixture('shared', 'saml').initial,
				'mapping-operation'
			)
	}
];

/** Uses the actual HTTP adapters and existing factor/receipt implementation, mocking only fetch and WebAuthn. */
function stubTrustStepUp(mutation: Mutation) {
	const writes: RequestInit[] = [];
	const paths: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init: RequestInit = {}) => {
			paths.push(url);
			if (url === mutation.path && init.method === mutation.method) {
				writes.push(init);
				return new Headers(init.headers).get('authrim-step-up-receipt') === 'trust-receipt'
					? json(mutation.success)
					: json(
							{
								error: 'step_up_required',
								step_up_id: 'trust-update',
								required_level: 'L2',
								missing: ['passkey', 'second_factor']
							},
							403
						);
			}
			if (url === mutation.path && (!init.method || init.method === 'GET')) return json(samlRow);
			if (url === '/api/admin/me/second-factors')
				return json({ second_factors: [{ kind: 'webauthn_credential', revoked_at: null }] });
			if (url.endsWith('/options'))
				return json({
					options: { challenge: 'test-challenge' },
					challenge_id: 'test-challenge-id'
				});
			if (url.endsWith('/verify')) return json({ verified: true, authenticated_at: 1 });
			if (url === '/api/admin/me/step-up/receipts') {
				expect(init.body).toBe(JSON.stringify({ step_up_id: 'trust-update' }));
				return json({ step_up_receipt: 'trust-receipt', expires_at: 1 });
			}
			throw new Error(`Unexpected test request: ${url}`);
		})
	);
	return { writes, paths };
}

describe('connection writes meet the existing federation trust step-up', () => {
	it.each(mutations)(
		'$name retries the identical HTTP payload after both factors and receipt',
		async (mutation) => {
			const { writes, paths } = stubTrustStepUp(mutation);
			await mutation.run();
			expect(writes).toHaveLength(2);
			expect(new Headers(writes[0].headers).get('authrim-step-up-receipt')).toBeNull();
			expect(new Headers(writes[1].headers).get('authrim-step-up-receipt')).toBe('trust-receipt');
			expect(typeof writes[0].body).toBe('string');
			expect(writes[1].body).toBe(writes[0].body);
			if (mutation.name.startsWith('SAML'))
				expect(new Headers(writes[1].headers).get('Idempotency-Key')).toBe(
					new Headers(writes[0].headers).get('Idempotency-Key')
				);
			expect(startAuthentication).toHaveBeenCalledTimes(2);
			expect(paths).toEqual([
				...(mutation.name === 'SAML mapping save' ? [mutation.path] : []),
				mutation.path,
				'/api/admin/me/reauth/passkey/options',
				'/api/admin/me/reauth/passkey/verify',
				'/api/admin/me/second-factors',
				'/api/admin/me/reauth/second-factor/options',
				'/api/admin/me/reauth/second-factor/verify',
				'/api/admin/me/step-up/receipts',
				mutation.path
			]);
			for (const write of writes) {
				expect(write.credentials).toBe('include');
				expect(new Headers(write.headers).get('X-Tenant-Id')).toBe('connection-test');
				if (mutation.name === 'SAML mapping save')
					expect(new Headers(write.headers).get('Idempotency-Key')).toBe('mapping-operation');
			}
		}
	);

	it.each(
		mutations.filter(
			(item) => item.name === 'SAML SP basic settings' || item.name.endsWith(' enable')
		)
	)('$name cancellation sends no retry and keeps the operation rejected', async (mutation) => {
		const { writes } = stubTrustStepUp(mutation);
		const unregister = setStepUpPrompt(async () => false);
		try {
			await expect(mutation.run()).rejects.toBeInstanceOf(StepUpCancelledError);
		} finally {
			unregister();
		}
		expect(writes).toHaveLength(1);
		expect(startAuthentication).not.toHaveBeenCalled();
	});

	it('freezes SAML settings and source version while the trust prompt is open', async () => {
		const mutation = mutations.find((item) => item.name === 'SAML SP basic settings');
		if (!mutation) throw new Error('Missing SP settings');
		const { writes } = stubTrustStepUp(mutation);
		const input = {
			name: 'Submitted',
			expectedUpdatedAt: samlRow.updatedAt,
			config: { acsUrl: sp.config.acsUrl }
		};
		const serialized = JSON.stringify({
			expectedUpdatedAt: input.expectedUpdatedAt,
			name: input.name,
			config: input.config
		});
		const unregister = setStepUpPrompt(async () => {
			input.name = 'Later edit';
			input.expectedUpdatedAt = 'later';
			input.config.acsUrl = 'https://later.example/acs';
			return true;
		});
		try {
			await httpSamlProviders.updateServiceProvider('provider', input);
		} finally {
			unregister();
		}
		expect(writes.map((write) => write.body)).toEqual([serialized, serialized]);
	});

	it('never replays a SAML activation into a different tenant after the prompt', async () => {
		const mutation = mutations.find((item) => item.name === 'SAML SP enable');
		if (!mutation) throw new Error('Missing SAML activation');
		const { writes } = stubTrustStepUp(mutation);
		const originalTenant = testTenant.tenantId;
		const unregister = setStepUpPrompt(async () => {
			testTenant.tenantId = 'other-tenant';
			return true;
		});
		try {
			await expect(mutation.run()).rejects.toBeInstanceOf(StepUpCancelledError);
		} finally {
			testTenant.tenantId = originalTenant;
			unregister();
		}
		expect(writes).toHaveLength(1);
		expect(new Headers(writes[0].headers).get('X-Tenant-Id')).toBe(originalTenant);
	});

	it('freezes the submitted body even if the caller changes its object during the factor prompt', async () => {
		const input = { ...oidc };
		const mutation = mutations.find((item) => item.name === 'OIDC OP create');
		if (!mutation) throw new Error('Missing test mutation');
		const { writes } = stubTrustStepUp(mutation);
		const submitted = JSON.stringify(input);
		const unregister = setStepUpPrompt(async () => {
			input.name = 'Changed during prompt';
			input.client_secret = 'different-test-secret';
			return true;
		});
		try {
			await httpExternalProviders.create(input);
		} finally {
			unregister();
		}
		expect(writes.map((write) => write.body)).toEqual([submitted, submitted]);
	});

	it.each(mutations.filter((mutation) => mutation.method === 'POST'))(
		'$name passes an ordinary 403 through without a factor or retry',
		async (mutation) => {
			const fetcher = vi.fn(async () =>
				json({ error: 'forbidden', error_description: 'Permission denied' }, 403)
			);
			vi.stubGlobal('fetch', fetcher);
			await expect(mutation.run()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(startAuthentication).not.toHaveBeenCalled();
		}
	);

	it('propagates cancellation, retaining all creation answers and the entered secret for retry', async () => {
		const mutation = mutations.find((item) => item.name === 'OIDC OP create');
		if (!mutation) throw new Error('Missing test mutation');
		const { writes, paths } = stubTrustStepUp(mutation);
		const answers = emptyAnswers();
		answers.direction = 'in';
		answers.kind = 'op';
		Object.assign(answers.op, {
			name: oidc.name,
			issuer: oidc.issuer,
			clientId: oidc.client_id,
			clientSecret: oidc.client_secret,
			scopes: oidc.scopes,
			link: 'manual',
			discovered: true,
			discovery: {
				issuer: oidc.issuer,
				authorization_endpoint: 'https://directory.example/login',
				token_endpoint: 'https://directory.example/token',
				jwks_uri: 'https://directory.example/jwks'
			}
		});
		const before = JSON.stringify(answers);
		const unregister = setStepUpPrompt(async () => false);
		try {
			await expect(
				createConnection(
					{
						clients: { create: vi.fn() },
						samlProviders: { createServiceProvider: vi.fn() },
						externalProviders: httpExternalProviders,
						canCreate: () => true
					},
					answers,
					''
				)
			).rejects.toBeInstanceOf(StepUpCancelledError);
		} finally {
			unregister();
		}
		expect(JSON.stringify(answers)).toBe(before);
		expect(answers.op.clientSecret).toBe(oidc.client_secret);
		expect(writes).toHaveLength(1);
		expect(paths).toEqual([mutation.path]);
		expect(startAuthentication).not.toHaveBeenCalled();
	});
});
