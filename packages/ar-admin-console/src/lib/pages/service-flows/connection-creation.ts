import { metadataInput } from './metadata-draft';
import type { ClientCreationClient, CreateClientInput } from '#lib/api/clients.js';
import type {
	ExternalProvidersClient,
	ExternalProviderCreate,
	ExternalProviderWrite,
	OidcDiscovery
} from '#lib/api/external-providers.js';
import type {
	SamlIdentityProvidersClient,
	CreateIdentityProviderInput,
	IdentityProviderConfig,
	SamlCreationClient,
	CreateServiceProviderInput,
	SamlMetadataClient
} from '#lib/api/saml-providers.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import {
	entityIdProblem,
	httpsUrlProblem,
	redirectUriProblem,
	type Answers,
	type OpForm,
	type IdpForm,
	type ConnectionKind,
	type RpForm
} from './connection-model';

export interface CreatedConnection {
	kind: ConnectionKind;
	id: string;
	clientSecret?: string;
}
export interface ConnectionCreationResources {
	previewMetadata?: SamlMetadataClient['preview'];
	clients: ClientCreationClient;
	samlProviders: SamlCreationClient;
	externalProviders?: ExternalProvidersClient;
	samlIdentityProviders?: SamlIdentityProvidersClient;
	canList?: (kind: ConnectionKind) => boolean;
	canCreate: (kind: ConnectionKind) => boolean;
}
export interface LiveConnectionCreation {
	previewMetadata?: SamlMetadataClient['preview'];
	kinds: ConnectionKind[];
	discover?: (issuer: string, signal?: AbortSignal) => Promise<OidcDiscovery>;
	create: (answers: Answers, serviceName: string) => Promise<CreatedConnection>;
	navigate: (connection: CreatedConnection) => void | Promise<void>;
}

export function rpRedirectsReady(form: RpForm): boolean {
	return (
		form.redirectUris.length > 0 &&
		new Set(form.redirectUris.map((uri) => uri.trim())).size === form.redirectUris.length &&
		form.redirectUris.every((uri) => !!uri.trim() && !redirectUriProblem(uri))
	);
}

export function rpCreateInput(form: RpForm): CreateClientInput {
	const method = form.authMethod;
	const publicClient = form.appType !== 'web';
	if (
		!form.name.trim() ||
		!rpRedirectsReady(form) ||
		(publicClient
			? method !== 'none' || !form.pkce
			: method !== 'client_secret_basic' && method !== 'client_secret_post') ||
		(method !== 'none' && method !== 'client_secret_basic' && method !== 'client_secret_post')
	) {
		throw new Error(t('sf.create.invalid'));
	}
	return {
		client_name: form.name.trim(),
		// The Admin API accepts SPA separately from native redirect and browser policies.
		application_type: form.appType,
		redirect_uris: form.redirectUris.map((uri) => uri.trim()),
		grant_types: ['authorization_code'],
		response_types: ['code'],
		scope: 'openid',
		token_endpoint_auth_method: method,
		require_pkce: form.pkce
	};
}

export function spCreateInput(answers: Answers, name: string): CreateServiceProviderInput {
	const form = answers.sp;
	const metadata = metadataInput(form);
	if (metadata) {
		if (!name.trim() || form.metadata?.preview?.providerType !== 'saml_sp')
			throw new Error(t('sf.create.invalid'));
		return { name: name.trim(), providerType: 'saml_sp', enabled: false, ...metadata };
	}
	if (
		!name.trim() ||
		form.importMode !== 'manual' ||
		entityIdProblem(form.entityId) ||
		httpsUrlProblem(form.acsUrl)
	) {
		throw new Error(t('sf.create.invalid'));
	}
	return {
		name: name.trim(),
		providerType: 'saml_sp',
		enabled: false,
		config: {
			entityId: form.entityId.trim(),
			acsUrl: form.acsUrl.trim(),
			allowedBindings: ['post'],
			signAssertions: true,
			signResponses: true
		}
	};
}

export function opWriteInput(form: OpForm, hasSecret = false): ExternalProviderWrite {
	if (
		!form.name.trim() ||
		httpsUrlProblem(form.issuer) ||
		!form.clientId.trim() ||
		(!hasSecret && !form.clientSecret) ||
		!form.scopes?.trim().split(/\s+/).includes('openid')
	)
		throw new Error(t('sf.create.invalid'));
	return {
		name: form.name.trim(),
		issuer: form.issuer.trim(),
		client_id: form.clientId.trim(),
		...(form.clientSecret ? { client_secret: form.clientSecret } : {}),
		scopes: form.scopes.trim(),
		auto_link_email: form.link === 'verified-email',
		require_email_verified: form.requireEmailVerified !== false,
		trust_email: form.trustEmail === true,
		jit_provisioning: form.jitProvisioning === true,
		...(form.discovery && form.discovered && form.discovery.issuer === form.issuer.trim()
			? {
					authorization_endpoint: form.discovery.authorization_endpoint,
					token_endpoint: form.discovery.token_endpoint,
					jwks_uri: form.discovery.jwks_uri,
					userinfo_endpoint: form.discovery.userinfo_endpoint ?? ''
				}
			: {})
	};
}
export function opCreateInput(form: OpForm): ExternalProviderCreate {
	if (
		!form.discovered ||
		!form.discovery ||
		form.discovery.issuer !== form.issuer.trim() ||
		!form.clientSecret
	)
		throw new Error(t('sf.create.invalid'));
	return {
		...opWriteInput(form),
		provider_type: 'oidc',
		client_secret: form.clientSecret,
		enabled: false
	};
}
export function idpConfig(form: IdpForm): IdentityProviderConfig {
	if (
		!form.name.trim() ||
		form.importMode !== 'manual' ||
		entityIdProblem(form.entityId) ||
		httpsUrlProblem(form.acsUrl) ||
		!form.certificate?.trim()
	)
		throw new Error(t('sf.create.invalid'));
	return {
		entityId: form.entityId.trim(),
		ssoUrl: form.acsUrl.trim(),
		certificate: form.certificate.trim()
	};
}
export function idpCreateInput(form: IdpForm): CreateIdentityProviderInput {
	const metadata = metadataInput(form);
	if (metadata) {
		if (!form.name.trim() || form.metadata?.preview?.providerType !== 'saml_idp')
			throw new Error(t('sf.create.invalid'));
		return {
			name: form.name.trim(),
			providerType: 'saml_idp',
			enabled: false,
			...metadata,
			config: { jitEmailLinkingPolicy: 'disabled', allowSyntheticEmailFallback: false }
		};
	}
	return {
		name: form.name.trim(),
		providerType: 'saml_idp',
		enabled: false,
		config: {
			...idpConfig(form),
			jitEmailLinkingPolicy: 'disabled',
			allowSyntheticEmailFallback: false
		}
	};
}

export async function createConnection(
	resources: ConnectionCreationResources,
	answers: Answers,
	name: string
): Promise<CreatedConnection> {
	const kind = answers.kind;
	if (
		!kind ||
		!resources.canCreate(kind) ||
		(kind === 'rp' || kind === 'sp' ? answers.direction !== 'out' : answers.direction !== 'in')
	) {
		throw new Error(t('sf.create.unavailable'));
	}
	switch (kind) {
		case 'rp':
			return { kind, ...(await resources.clients.create(rpCreateInput(answers.rp))) };
		case 'sp':
			return {
				kind,
				...(await resources.samlProviders.createServiceProvider(spCreateInput(answers, name)))
			};
		case 'op':
			if (resources.externalProviders)
				return { kind, ...(await resources.externalProviders.create(opCreateInput(answers.op))) };
			break;
		case 'idp':
			if (resources.samlIdentityProviders)
				return {
					kind,
					...(await resources.samlIdentityProviders.createIdentityProvider(
						idpCreateInput(answers.idp)
					))
				};
	}
	throw new Error(t('sf.create.unavailable'));
}

export function connectionPath(connection: CreatedConnection): string {
	return `/admin/applications/all/${connection.kind}/${encodeURIComponent(connection.id)}`;
}
