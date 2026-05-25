import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Cache Mode API Client
 *
 * Provides API calls for cache mode management:
 * - Get/Set platform cache mode
 * - Get/Set client-specific cache mode
 * - Get cache mode info
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

function buildHeaders(): Record<string, string> {
	return {
		'Content-Type': 'application/json'
	};
}

/**
 * Cache mode type
 */
export type CacheMode = 'maintenance' | 'fixed';

/**
 * TTL configuration for cache mode
 */
export interface CacheTTLConfig {
	clientMetadata: number;
	redirectUris: number;
	grantTypes: number;
	scopes: number;
	jwks: number;
	clientSecret: number;
	tenant: number;
	policy: number;
}

/**
 * Platform cache mode response
 */
export interface PlatformCacheModeResponse {
	mode: CacheMode | null;
	effective: CacheMode;
	ttl_config: CacheTTLConfig;
}

/**
 * Client cache mode response
 */
export interface ClientCacheModeResponse {
	client_id: string;
	mode: CacheMode | null;
	effective: CacheMode;
	uses_platform_default: boolean;
}

/**
 * Cache mode info response
 */
export interface CacheModeInfoResponse {
	modes: {
		maintenance: {
			description: string;
			ttl_config: CacheTTLConfig;
			use_cases: string[];
		};
		fixed: {
			description: string;
			ttl_config: CacheTTLConfig;
			use_cases: string[];
		};
	};
	default_mode: CacheMode;
	hierarchy: {
		description: string;
		order: string[];
	};
	kv_key_version: string;
	note: string;
}

/**
 * Set cache mode response
 */
export interface SetCacheModeResponse {
	success: boolean;
	mode: CacheMode | null;
	ttl_config?: CacheTTLConfig;
	message: string;
	client_id?: string;
	effective?: CacheMode;
	uses_platform_default?: boolean;
}

/**
 * Admin Cache Mode API
 */
export const adminCacheModeAPI = {
	/**
	 * Get platform cache mode configuration
	 * GET /api/admin/settings/cache-mode
	 */
	async getPlatformCacheMode(): Promise<PlatformCacheModeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/cache-mode`, {
			credentials: 'include',
			headers: buildHeaders()
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch cache mode');
		}

		return response.json();
	},

	/**
	 * Set platform cache mode
	 * POST /api/admin/settings/cache-mode
	 */
	async setPlatformCacheMode(mode: CacheMode): Promise<SetCacheModeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/cache-mode`, {
			method: 'POST',
			credentials: 'include',
			headers: buildHeaders(),
			body: JSON.stringify({ mode })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to set cache mode');
		}

		return response.json();
	},

	/**
	 * Get cache mode info (descriptions and use cases)
	 * GET /api/admin/settings/cache-mode/info
	 */
	async getCacheModeInfo(): Promise<CacheModeInfoResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/cache-mode/info`, {
			credentials: 'include',
			headers: buildHeaders()
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch cache mode info');
		}

		return response.json();
	},

	/**
	 * Get client-specific cache mode
	 * GET /api/admin/clients/:clientId/cache-mode
	 */
	async getClientCacheMode(clientId: string): Promise<ClientCacheModeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients/${clientId}/cache-mode`, {
			credentials: 'include',
			headers: buildHeaders()
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch client cache mode');
		}

		return response.json();
	},

	/**
	 * Set client-specific cache mode
	 * POST /api/admin/clients/:clientId/cache-mode
	 *
	 * @param clientId - Client ID
	 * @param mode - Cache mode or null to use platform default
	 */
	async setClientCacheMode(
		clientId: string,
		mode: CacheMode | null
	): Promise<SetCacheModeResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/clients/${clientId}/cache-mode`, {
			method: 'POST',
			credentials: 'include',
			headers: buildHeaders(),
			body: JSON.stringify({ mode })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to set client cache mode');
		}

		return response.json();
	}
};
