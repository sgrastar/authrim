import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin External IdP Providers API Client
 *
 * Provides methods for managing external identity providers (Google, GitHub, etc.)
 * through the Admin API.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * External IdP Provider (Admin view with full details)
 */
export interface ExternalIdPProvider {
	id: string;
	slug?: string;
	tenantId: string;
	name: string;
	providerType: 'oidc' | 'oauth2';
	enabled: boolean;
	priority: number;
	issuer?: string;
	clientId: string;
	hasSecret: boolean;
	authorizationEndpoint?: string;
	tokenEndpoint?: string;
	userinfoEndpoint?: string;
	jwksUri?: string;
	scopes: string;
	attributeMapping: Record<string, string>;
	autoLinkEmail: boolean;
	jitProvisioning: boolean;
	requireEmailVerified: boolean;
	alwaysFetchUserinfo?: boolean;
	enableSso?: boolean;
	iconUrl?: string;
	iconName?: string;
	buttonColor?: string;
	buttonColorDark?: string;
	buttonText?: string;
	providerQuirks?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

/**
 * Provider list response
 */
export interface ExternalIdPProviderListResponse {
	providers: ExternalIdPProvider[];
}

/**
 * Provider templates available for quick setup
 */
export type ProviderTemplate =
	| 'google'
	| 'github'
	| 'microsoft'
	| 'linkedin'
	| 'facebook'
	| 'twitter'
	| 'apple';

/**
 * Provider template display info
 */
export interface ProviderTemplateInfo {
	id: ProviderTemplate;
	name: string;
	description: string;
	providerType: 'oidc' | 'oauth2';
	icon: string;
}

/**
 * Available provider templates
 */
export const PROVIDER_TEMPLATES: ProviderTemplateInfo[] = [
	{
		id: 'google',
		name: 'Google',
		description: 'Google Sign-In (OIDC)',
		providerType: 'oidc',
		icon: 'i-ph-google-logo'
	},
	{
		id: 'github',
		name: 'GitHub',
		description: 'GitHub OAuth 2.0',
		providerType: 'oauth2',
		icon: 'i-ph-github-logo'
	},
	{
		id: 'microsoft',
		name: 'Microsoft',
		description: 'Microsoft Entra ID (OIDC)',
		providerType: 'oidc',
		icon: 'i-ph-windows-logo'
	},
	{
		id: 'linkedin',
		name: 'LinkedIn',
		description: 'LinkedIn OpenID Connect',
		providerType: 'oidc',
		icon: 'i-ph-linkedin-logo'
	},
	{
		id: 'facebook',
		name: 'Facebook',
		description: 'Facebook OAuth 2.0',
		providerType: 'oauth2',
		icon: 'i-ph-meta-logo'
	},
	{
		id: 'twitter',
		name: 'Twitter',
		description: 'Twitter OAuth 2.0',
		providerType: 'oauth2',
		icon: 'i-ph-x-logo'
	},
	{
		id: 'apple',
		name: 'Apple',
		description: 'Sign in with Apple (OIDC)',
		providerType: 'oidc',
		icon: 'i-ph-apple-logo'
	}
];

/**
 * Create Provider Request
 */
export interface CreateProviderRequest {
	slug?: string;
	name: string;
	provider_type?: 'oidc' | 'oauth2';
	client_id: string;
	client_secret: string;
	issuer?: string;
	scopes?: string;
	enabled?: boolean;
	priority?: number;
	auto_link_email?: boolean;
	jit_provisioning?: boolean;
	require_email_verified?: boolean;
	always_fetch_userinfo?: boolean;
	icon_url?: string | null;
	icon_name?: string | null;
	button_color?: string;
	button_color_dark?: string;
	button_text?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	attribute_mapping?: Record<string, string>;
	provider_quirks?: Record<string, unknown>;
	template?: ProviderTemplate;
}

/**
 * OIDC Discovery Response (subset of OpenID Configuration)
 */
export interface OidcDiscoveryResponse {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	scopes_supported?: string[];
	response_types_supported?: string[];
	grant_types_supported?: string[];
	subject_types_supported?: string[];
	id_token_signing_alg_values_supported?: string[];
	claims_supported?: string[];
	discovery_source?: {
		method: 'webfinger';
		resource: string;
		webfinger_endpoint: string;
	};
}

/**
 * Update Provider Request
 */
export interface UpdateProviderRequest {
	slug?: string;
	name?: string;
	provider_type?: 'oidc' | 'oauth2';
	client_id?: string;
	client_secret?: string;
	issuer?: string;
	scopes?: string;
	enabled?: boolean;
	priority?: number;
	auto_link_email?: boolean;
	jit_provisioning?: boolean;
	require_email_verified?: boolean;
	always_fetch_userinfo?: boolean;
	enable_sso?: boolean;
	icon_url?: string | null;
	icon_name?: string | null;
	button_color?: string;
	button_color_dark?: string;
	button_text?: string;
	authorization_endpoint?: string;
	token_endpoint?: string;
	userinfo_endpoint?: string;
	jwks_uri?: string;
	attribute_mapping?: Record<string, string>;
	provider_quirks?: Record<string, unknown>;
}

export const adminExternalProvidersAPI = {
	/**
	 * List all external IdP providers
	 */
	async list(params: { tenant_id?: string } = {}): Promise<ExternalIdPProviderListResponse> {
		const searchParams = new URLSearchParams();
		if (params.tenant_id) searchParams.set('tenant_id', params.tenant_id);
		const query = searchParams.toString();

		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers${query ? '?' + query : ''}`,
			{ credentials: 'include' }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch providers');
		}
		return response.json();
	},

	/**
	 * Get a single provider by ID
	 */
	async get(providerId: string): Promise<ExternalIdPProvider> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers/${encodeURIComponent(providerId)}`,
			{ credentials: 'include' }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch provider');
		}
		return response.json();
	},

	/**
	 * Create a new external IdP provider
	 */
	async create(data: CreateProviderRequest): Promise<ExternalIdPProvider> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/external-providers`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create provider');
		}
		return response.json();
	},

	/**
	 * Update an existing provider
	 */
	async update(providerId: string, data: UpdateProviderRequest): Promise<ExternalIdPProvider> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers/${encodeURIComponent(providerId)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update provider');
		}
		return response.json();
	},

	async registerDynamic(
		providerId: string
	): Promise<{ registered: boolean; provider: ExternalIdPProvider }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers/${encodeURIComponent(providerId)}/register`,
			{
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: '{}'
			}
		);
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				error_description?: string;
				message?: string;
			};
			throw new Error(body.error_description || body.message || 'Dynamic registration failed');
		}
		return response.json();
	},

	/**
	 * Delete a provider
	 */
	async delete(providerId: string): Promise<{ success: boolean }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers/${encodeURIComponent(providerId)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete provider');
		}
		return response.json();
	},

	/**
	 * Discover OIDC configuration from a well-known endpoint
	 * Uses backend proxy to avoid CORS issues
	 *
	 * @param url - The issuer URL or full discovery URL
	 * @returns OpenID Configuration object
	 */
	async discoverOidcConfig(
		value: string,
		mode: 'url' | 'webfinger' = 'url'
	): Promise<OidcDiscoveryResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/external-providers/discover-oidc`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(mode === 'webfinger' ? { resource: value } : { url: value })
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error || error.message || 'Failed to discover OIDC configuration');
		}
		return response.json();
	}
};
