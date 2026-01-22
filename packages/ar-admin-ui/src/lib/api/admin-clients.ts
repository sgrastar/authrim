/**
 * Admin Clients API Client
 *
 * Provides methods for managing OAuth clients through the Admin API.
 *
 * NOTE: Client deletion is currently HARD DELETE (physical deletion).
 * TODO: Phase 4（監査ログ）実装時に論理削除への変更を検討
 * 現在は物理削除のため、削除されたclient_idで発行されたトークンの追跡が困難
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export interface Client {
	client_id: string;
	client_name: string;
	client_secret?: string;
	grant_types: string[];
	response_types: string[];
	redirect_uris: string[];
	token_endpoint_auth_method: string;
	scope?: string;
	id_token_signed_response_alg?: string;
	require_pkce?: boolean;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
	created_at: number;
	updated_at: number;
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
	redirect_uris: string[];
	grant_types?: string[];
	response_types?: string[];
	token_endpoint_auth_method?: string;
	scope?: string;
	require_pkce?: boolean;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
}

export interface UpdateClientInput {
	client_name?: string;
	redirect_uris?: string[];
	grant_types?: string[];
	response_types?: string[];
	token_endpoint_auth_method?: string;
	scope?: string;
	require_pkce?: boolean;
	access_token_ttl?: number;
	refresh_token_ttl?: number;
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

		const response = await fetch(`${API_BASE_URL}/api/admin/clients?${searchParams}`, {
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
		const response = await fetch(
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
		const response = await fetch(`${API_BASE_URL}/api/admin/clients`, {
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
		const response = await fetch(
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
		const response = await fetch(
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
		const response = await fetch(
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
		const response = await fetch(
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
		const response = await fetch(`${API_BASE_URL}/api/admin/client-profile-presets`, {
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
		const response = await fetch(
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
