import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Clients API Client
 *
 * Provides methods for managing OAuth clients through the Admin API.
 *
 * NOTE: Client deletion is currently HARD DELETE (physical deletion).
 * TODO: Consider switching to soft deletion when Phase 4 audit logs are implemented
 * Currently uses physical deletion, which makes tokens issued for deleted client_id values difficult to trace
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type ClaimReleasePolicy = 'scope_required' | 'claims_allowed' | 'forbidden';
export type ClaimsParameterPolicy = Record<string, ClaimReleasePolicy>;

export interface Client {
	client_id: string;
	client_name: string;
	description?: string | null;
	client_secret?: string;
	grant_types: string[];
	response_types: string[];
	redirect_uris: string[];
	token_endpoint_auth_method: string;
	browser_public_client_mode?: 'strict' | 'cookie_fallback' | null;
	browser_refresh_token_policy?: 'disabled' | 'dpop_bound' | null;
	scope?: string;
	contacts?: string[];
	logo_uri?: string | null;
	client_uri?: string | null;
	policy_uri?: string | null;
	tos_uri?: string | null;
	is_trusted?: boolean;
	skip_consent?: boolean;
	allow_claims_without_scope?: boolean;
	claims_parameter_policy?: ClaimsParameterPolicy | null;
	asc_enabled?: boolean;
	asc_protected_request_required?: boolean;
	asc_sao_enabled?: boolean;
	asc_transformed_claims_enabled?: boolean;
	asc_allowed_transformed_claims?: string[] | null;
	login_ui_url?: string | null;
	id_token_signed_response_alg?: string;
	require_pkce?: boolean;
	token_exchange_allowed?: boolean;
	allowed_subject_token_clients?: string[];
	allowed_token_exchange_resources?: string[];
	delegation_mode?: 'none' | 'delegation' | 'impersonation';
	client_credentials_allowed?: boolean;
	allowed_scopes?: string[];
	default_scope?: string | null;
	default_audience?: string | null;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	web_origin_registry?: WebOriginRegistry;
	created_at: number;
	updated_at: number;
}

export interface WebOriginRegistry {
	origins: WebOriginRegistryEntry[];
}

export interface WebOriginRegistryEntry {
	origin: string;
	client_ids?: string[];
	cors?: {
		allowed?: boolean;
	};
	csp?: {
		frame_ancestors?: string[];
	};
	handoff_allowed?: boolean;
	iframe_allowed?: boolean;
	environment?: string;
}

export interface ClientListResponse {
	clients: Client[];
	pagination: {
		page: number;
		limit: number;
		total: number;
		totalPages: number;
		hasNext: boolean;
		hasPrev: boolean;
	};
}

export interface ClientListParams {
	page?: number;
	limit?: number;
	search?: string;
}

export interface CreateClientInput {
	client_name: string;
	description?: string | null;
	redirect_uris: string[];
	grant_types?: string[];
	response_types?: string[];
	token_endpoint_auth_method?: string;
	browser_public_client_mode?: 'strict' | 'cookie_fallback' | null;
	browser_refresh_token_policy?: 'disabled' | 'dpop_bound' | null;
	scope?: string;
	require_pkce?: boolean;
	allow_claims_without_scope?: boolean;
	claims_parameter_policy?: ClaimsParameterPolicy | null;
	asc_enabled?: boolean;
	asc_protected_request_required?: boolean;
	asc_sao_enabled?: boolean;
	asc_transformed_claims_enabled?: boolean;
	asc_allowed_transformed_claims?: string[] | null;
	token_exchange_allowed?: boolean;
	allowed_subject_token_clients?: string[];
	allowed_token_exchange_resources?: string[];
	delegation_mode?: 'none' | 'delegation' | 'impersonation';
	client_credentials_allowed?: boolean;
	allowed_scopes?: string[];
	default_scope?: string;
	default_audience?: string;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	web_origin_registry?: WebOriginRegistry;
}

export interface UpdateClientInput {
	client_name?: string;
	description?: string | null;
	redirect_uris?: string[];
	grant_types?: string[];
	response_types?: string[];
	token_endpoint_auth_method?: string;
	browser_public_client_mode?: 'strict' | 'cookie_fallback' | null;
	browser_refresh_token_policy?: 'disabled' | 'dpop_bound' | null;
	scope?: string;
	login_ui_url?: string | null;
	require_pkce?: boolean;
	allow_claims_without_scope?: boolean;
	claims_parameter_policy?: ClaimsParameterPolicy | null;
	asc_enabled?: boolean;
	asc_protected_request_required?: boolean;
	asc_sao_enabled?: boolean;
	asc_transformed_claims_enabled?: boolean;
	asc_allowed_transformed_claims?: string[] | null;
	token_exchange_allowed?: boolean;
	allowed_subject_token_clients?: string[];
	allowed_token_exchange_resources?: string[];
	delegation_mode?: 'none' | 'delegation' | 'impersonation';
	client_credentials_allowed?: boolean;
	allowed_scopes?: string[];
	default_scope?: string | null;
	default_audience?: string | null;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	web_origin_registry?: WebOriginRegistry | null;
}

export interface ClientUsage {
	tokens_issued_24h: number;
	tokens_issued_7d: number;
	tokens_issued_30d: number;
	active_sessions: number;
	last_token_issued_at: number | null;
}

/**
 * Client Profile Preset
 * Pre-configured settings for common OAuth client types
 */
export interface ClientProfilePreset {
	id: string;
	name: string;
	description: string;
	clientType: 'public' | 'confidential';
}

/**
 * Client Profile Presets Response
 */
export interface ClientProfilePresetsResponse {
	presets: ClientProfilePreset[];
}

export const adminClientsAPI = {
	/**
	 * List all OAuth clients with pagination and search
	 */
	async list(params?: ClientListParams): Promise<ClientListResponse> {
		const searchParams = new URLSearchParams();
		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.search) searchParams.set('search', params.search);

		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients?${searchParams}`, {
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch clients');
		}
		return response.json();
	},

	/**
	 * Get a single client by ID
	 */
	async get(clientId: string): Promise<Client> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}`,
			{ credentials: 'include' }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch client');
		}
		const data = await response.json();
		return data.client;
	},

	/**
	 * Create a new OAuth client
	 */
	async create(data: CreateClientInput): Promise<Client> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to create client');
		}
		const result = await response.json();
		return result.client;
	},

	/**
	 * Update an existing client
	 */
	async update(clientId: string, data: UpdateClientInput): Promise<Client> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to update client');
		}
		const result = await response.json();
		return result.client;
	},

	/**
	 * Delete a client
	 */
	async delete(clientId: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to delete client');
		}
	},

	/**
	 * Regenerate client secret
	 * Note: The new secret is only shown once in the response
	 */
	async regenerateSecret(clientId: string): Promise<{ client_secret: string }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}/regenerate-secret`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to regenerate secret');
		}
		return response.json();
	},

	/**
	 * Get client usage statistics
	 */
	async getUsage(clientId: string): Promise<ClientUsage> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}/usage`,
			{ credentials: 'include' }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch usage');
		}
		return response.json();
	},

	/**
	 * Get available client profile presets
	 * GET /api/admin/client-profile-presets
	 */
	async getPresets(): Promise<ClientProfilePresetsResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/client-profile-presets`, {
			credentials: 'include'
		});
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch presets');
		}
		return response.json();
	},

	/**
	 * Apply a preset to an existing client
	 * POST /api/admin/clients/:id/apply-preset
	 */
	async applyPreset(clientId: string, presetId: string): Promise<Client> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/clients/${encodeURIComponent(clientId)}/apply-preset`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify({ preset_id: presetId })
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to apply preset');
		}
		return response.json();
	}
};
