import { OP_FIELDS } from '#lib/pages/service-flows/advanced-settings.js';
import { API_BASE_URL, adminFetch } from './admin-request';
import { tenantScope } from '#lib/auth/tenant-scope.svelte.js';
import { StepUpCancelledError, stepUpHeaders, withStepUp } from './admin-step-up';
import { errorFromResponse } from './api-error';

export interface OidcDiscovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	userinfo_endpoint?: string;
}
export interface ExternalProvider {
	updatedAt?: number;
	advanced?: Record<string, unknown>;
	id: string;
	name: string;
	issuer: string;
	clientId: string;
	hasSecret: boolean;
	scopes: string;
	enabled: boolean;
	autoLinkEmail: boolean;
	jitProvisioning: boolean;
	requireEmailVerified: boolean;
	trustEmail: boolean;
}
export interface ExternalProviderWrite {
	expected_updated_at?: number;
	advanced?: Record<string, unknown>;
	name: string;
	issuer: string;
	client_id: string;
	client_secret?: string;
	scopes: string;
	auto_link_email: boolean;
	jit_provisioning: boolean;
	require_email_verified: boolean;
	trust_email: boolean;
	enabled?: boolean;
	authorization_endpoint?: string;
	token_endpoint?: string;
	jwks_uri?: string;
	userinfo_endpoint?: string;
}
export type ExternalProviderUpdate = Partial<ExternalProviderWrite>;
export interface ExternalProviderCreate extends ExternalProviderWrite {
	provider_type: 'oidc';
	client_secret: string;
}
export interface ExternalProvidersClient {
	list(): Promise<ExternalProvider[]>;
	get(id: string): Promise<ExternalProvider>;
	create(input: ExternalProviderCreate): Promise<{ id: string }>;
	update(id: string, input: ExternalProviderUpdate): Promise<ExternalProvider>;
	discover(issuer: string, signal?: AbortSignal): Promise<OidcDiscovery>;
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

function providerFromRow(value: unknown): ExternalProvider {
	const row = object(value);
	if (!row.id || typeof row.id !== 'string' || row.providerType !== 'oidc')
		throw new Error('Invalid OIDC provider response');
	// Deliberately copy only public fields. A saved credential is represented only by hasSecret.
	return {
		id: row.id,
		updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : undefined,
		advanced: Object.fromEntries(OP_FIELDS.map(({ key }) => [key, row[key] ?? null])),
		name: string(row.name),
		issuer: string(row.issuer),
		clientId: string(row.clientId),
		hasSecret: row.hasSecret === true,
		scopes: string(row.scopes),
		enabled: row.enabled === true,
		autoLinkEmail: row.autoLinkEmail === true,
		jitProvisioning: row.jitProvisioning === true,
		requireEmailVerified: row.requireEmailVerified !== false,
		trustEmail: row.trustEmail === true
	};
}
async function request(path = '', options: RequestInit = {}): Promise<unknown> {
	const response = await adminFetch(`${API_BASE_URL}/api/admin/external-providers${path}`, {
		...options,
		includeJsonContentType: !!options.body
	});
	if (!response.ok) throw await errorFromResponse(response);
	return response.json();
}
export const httpExternalProviders: ExternalProvidersClient = {
	async list() {
		const body = object(await request());
		return Array.isArray(body.providers)
			? body.providers.filter((row) => object(row).providerType === 'oidc').map(providerFromRow)
			: [];
	},
	async get(id) {
		return providerFromRow(await request(`/${encodeURIComponent(id)}`));
	},
	async create(input) {
		const body = JSON.stringify(input);
		return withStepUp(async (receipt) => {
			const provider = providerFromRow(
				await request('', { method: 'POST', body, headers: stepUpHeaders(receipt) })
			);
			return { id: provider.id };
		});
	},
	async update(id, input) {
		const tenantId = tenantScope.tenantId;
		const { advanced, ...basic } = input;
		const body = JSON.stringify({ ...basic, ...providerAdvancedWrite(advanced ?? {}) });
		return withStepUp(async (receipt) => {
			if (tenantScope.tenantId !== tenantId) throw new StepUpCancelledError();
			return providerFromRow(
				await request(`/${encodeURIComponent(id)}`, {
					method: 'PUT',
					body,
					headers: stepUpHeaders(receipt)
				})
			);
		});
	},
	async discover(issuer, signal) {
		const row = object(
			await request('/discover-oidc', {
				method: 'POST',
				body: JSON.stringify({ url: issuer }),
				signal
			})
		);
		if (
			typeof row.issuer !== 'string' ||
			typeof row.authorization_endpoint !== 'string' ||
			typeof row.token_endpoint !== 'string' ||
			typeof row.jwks_uri !== 'string'
		)
			throw new Error('Invalid OIDC discovery response');
		return {
			issuer: row.issuer,
			authorization_endpoint: row.authorization_endpoint,
			token_endpoint: row.token_endpoint,
			jwks_uri: row.jwks_uri,
			...(typeof row.userinfo_endpoint === 'string'
				? { userinfo_endpoint: row.userinfo_endpoint }
				: {})
		};
	}
};

const ADVANCED_WRITE_FIELDS: Record<string, string> = {
	authorizationEndpoint: 'authorization_endpoint',
	tokenEndpoint: 'token_endpoint',
	userinfoEndpoint: 'userinfo_endpoint',
	jwksUri: 'jwks_uri',
	tokenEndpointAuthMethod: 'token_endpoint_auth_method',
	alwaysFetchUserinfo: 'always_fetch_userinfo',
	profileUpdateFields: 'profile_update_fields',
	enableSso: 'enable_sso',
	buttonText: 'button_text',
	buttonColor: 'button_color',
	priority: 'priority'
};
function providerAdvancedWrite(input: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(ADVANCED_WRITE_FIELDS)
			.filter(([key]) => key in input)
			.map(([key, wire]) => [wire, input[key]])
	);
}
