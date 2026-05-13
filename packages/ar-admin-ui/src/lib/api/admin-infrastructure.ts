import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Infrastructure API Client
 *
 * Provides API calls for infrastructure sharding configuration:
 * - Session Shards: GET/PUT /api/admin/settings/session-shards
 * - Challenge Shards: GET/PUT /api/admin/settings/challenge-shards
 * - Code Shards: GET/PUT /api/admin/settings/code-shards
 * - Revocation Shards: GET/PUT /api/admin/settings/revocation-shards
 * - Region Shards: GET/PUT /api/admin/settings/region-shards
 * - Refresh Token Sharding: GET/PUT /api/admin/settings/refresh-token-sharding
 *
 * These endpoints allow runtime configuration of DO shard counts
 * without requiring redeployment.
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Shard configuration response
 */
export interface ShardConfig {
	current: number;
	source: 'kv' | 'env' | 'default';
	kv_value: number | null;
	env_value: number | null;
	default_value?: number;
}

/**
 * Shard update response
 */
export interface ShardUpdateResponse {
	success: boolean;
	shards: number;
	note: string;
}

/**
 * Region shard configuration
 */
export interface RegionShardConfig {
	currentGeneration: number;
	currentTotalShards: number;
	currentRegions: Record<string, { start: number; end: number; count: number }>;
	previousGenerations: Array<{
		generation: number;
		totalShards: number;
		regions: Record<string, { start: number; end: number; count: number }>;
		deprecatedAt: number;
	}>;
	maxPreviousGenerations: number;
	updatedAt: number;
	updatedBy?: string;
	version: number;
	groups: Record<
		string,
		{
			totalShards: number;
			members: string[];
			description?: string;
		}
	>;
	validation: {
		valid: boolean;
		errors: string[];
		warnings: string[];
	};
}

/**
 * Refresh token shard configuration
 */
export interface RefreshTokenShardConfig {
	currentGeneration: number;
	currentShardCount: number;
	previousGenerations: Array<{
		generation: number;
		shardCount: number;
		deprecatedAt: number;
	}>;
	updatedAt: number;
	updatedBy?: string;
}

/**
 * Refresh token sharding response
 */
export interface RefreshTokenShardingResponse {
	clientId: string;
	config: RefreshTokenShardConfig;
}

/**
 * Admin Infrastructure API
 */
export const adminInfrastructureAPI = {
	// =========================================================================
	// Session Shards API
	// =========================================================================

	/**
	 * Get session shard configuration
	 * GET /api/admin/settings/session-shards
	 */
	async getSessionShards(): Promise<ShardConfig> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/session-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch session shards');
		}

		return response.json();
	},

	/**
	 * Update session shard count
	 * PUT /api/admin/settings/session-shards
	 *
	 * Note: Changing shard count affects routing of new sessions.
	 * Existing sessions will continue to work as they use embedded routing.
	 *
	 * @param shards - Number of shards (1-256)
	 */
	async updateSessionShards(shards: number): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/session-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update session shards');
		}

		return response.json();
	},

	// =========================================================================
	// Challenge Shards API
	// =========================================================================

	/**
	 * Get challenge shard configuration
	 * GET /api/admin/settings/challenge-shards
	 */
	async getChallengeShards(): Promise<ShardConfig> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/challenge-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch challenge shards');
		}

		return response.json();
	},

	/**
	 * Update challenge shard count
	 * PUT /api/admin/settings/challenge-shards
	 *
	 * Note: Changing shard count affects routing of new challenges.
	 * Existing challenges will continue to work as they use embedded routing.
	 *
	 * @param shards - Number of shards (1-256)
	 */
	async updateChallengeShards(shards: number): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/challenge-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update challenge shards');
		}

		return response.json();
	},

	// =========================================================================
	// Code Shards API
	// =========================================================================

	/**
	 * Get code shard configuration
	 * GET /api/admin/settings/code-shards
	 */
	async getCodeShards(): Promise<ShardConfig> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/code-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch code shards');
		}

		return response.json();
	},

	/**
	 * Update code shard count
	 * PUT /api/admin/settings/code-shards
	 *
	 * IMPORTANT: AuthCode and RefreshToken must have identical shard counts.
	 * When updating from Scale UI, use skipSyncCheck=true to update both together.
	 *
	 * @param shards - Number of shards (1-256)
	 * @param skipSyncCheck - Skip sync validation (use when updating both AuthCode and RefreshToken together)
	 */
	async updateCodeShards(shards: number, skipSyncCheck = true): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/code-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards, skip_sync_check: skipSyncCheck })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(
				error.error_description || error.message || error.error || 'Failed to update code shards'
			);
		}

		return response.json();
	},

	/**
	 * Get revocation shard configuration
	 * GET /api/admin/settings/revocation-shards
	 */
	async getRevocationShards(): Promise<ShardConfig> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/revocation-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch revocation shards');
		}

		return response.json();
	},

	/**
	 * Update revocation shard count
	 * PUT /api/admin/settings/revocation-shards
	 *
	 * @param shards - Number of shards (1-256)
	 */
	async updateRevocationShards(shards: number): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/revocation-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update revocation shards');
		}

		return response.json();
	},

	// =========================================================================
	// Region Shards API
	// =========================================================================

	/**
	 * Get region shard configuration
	 * GET /api/admin/settings/region-shards
	 */
	async getRegionShards(): Promise<RegionShardConfig> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/region-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch region shards');
		}

		return response.json();
	},

	/**
	 * Update region shard configuration
	 * PUT /api/admin/settings/region-shards
	 */
	async updateRegionShards(
		totalShards: number,
		regionDistribution: Record<string, number>
	): Promise<{ success: boolean; generation: number }> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/region-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ totalShards, regionDistribution })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update region shards');
		}

		return response.json();
	},

	// =========================================================================
	// Refresh Token Sharding API
	// =========================================================================

	/**
	 * Get refresh token sharding configuration
	 * GET /api/admin/settings/refresh-token-sharding
	 */
	async getRefreshTokenSharding(clientId?: string): Promise<RefreshTokenShardingResponse> {
		const url = new URL(
			`${API_BASE_URL}/api/admin/settings/refresh-token-sharding`,
			window.location.origin
		);
		if (clientId) {
			url.searchParams.set('clientId', clientId);
		}

		const response = await adminFetch(url.toString(), {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch refresh token sharding');
		}

		return response.json();
	},

	/**
	 * Update refresh token sharding configuration
	 * PUT /api/admin/settings/refresh-token-sharding
	 *
	 * IMPORTANT: AuthCode and RefreshToken must have identical shard counts.
	 * When updating from Scale UI, use skipSyncCheck=true to update both together.
	 *
	 * @param shardCount - Number of shards (1-256)
	 * @param clientId - Optional client ID for client-specific config
	 * @param notes - Optional notes for audit
	 * @param skipSyncCheck - Skip sync validation (use when updating both AuthCode and RefreshToken together)
	 */
	async updateRefreshTokenSharding(
		shardCount: number,
		clientId?: string,
		notes?: string,
		skipSyncCheck = true
	): Promise<{ success: boolean; config: RefreshTokenShardConfig }> {
		if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await adminFetch(`${API_BASE_URL}/api/admin/settings/refresh-token-sharding`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shardCount, clientId, notes, skip_sync_check: skipSyncCheck })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(
				error.error_description ||
					error.message ||
					error.error ||
					'Failed to update refresh token sharding'
			);
		}

		return response.json();
	}
};
