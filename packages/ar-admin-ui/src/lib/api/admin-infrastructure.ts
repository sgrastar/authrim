/**
 * Admin Infrastructure API Client
 *
 * Provides API calls for infrastructure sharding configuration:
 * - Flow State Shards: GET/PUT /api/admin/settings/flow-state-shards
 * - Code Shards: GET/PUT /api/admin/settings/code-shards
 * - Revocation Shards: GET/PUT /api/admin/settings/revocation-shards
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
 * Admin Infrastructure API
 */
export const adminInfrastructureAPI = {
	/**
	 * Get flow state shard configuration
	 * GET /api/admin/settings/flow-state-shards
	 */
	async getFlowStateShards(): Promise<ShardConfig> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/flow-state-shards`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch flow state shards');
		}

		return response.json();
	},

	/**
	 * Update flow state shard count
	 * PUT /api/admin/settings/flow-state-shards
	 *
	 * Note: Changing shard count affects routing of new sessions.
	 * Existing sessions will continue to work as they use embedded routing.
	 *
	 * @param shards - Number of shards (1-256)
	 */
	async updateFlowStateShards(shards: number): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await fetch(`${API_BASE_URL}/api/admin/settings/flow-state-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update flow state shards');
		}

		return response.json();
	},

	/**
	 * Get code shard configuration
	 * GET /api/admin/settings/code-shards
	 */
	async getCodeShards(): Promise<ShardConfig> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/code-shards`, {
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
	 * @param shards - Number of shards (1-256)
	 */
	async updateCodeShards(shards: number): Promise<ShardUpdateResponse> {
		if (!Number.isInteger(shards) || shards < 1 || shards > 256) {
			throw new Error('Shard count must be an integer between 1 and 256');
		}

		const response = await fetch(`${API_BASE_URL}/api/admin/settings/code-shards`, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json'
			},
			credentials: 'include',
			body: JSON.stringify({ shards })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to update code shards');
		}

		return response.json();
	},

	/**
	 * Get revocation shard configuration
	 * GET /api/admin/settings/revocation-shards
	 */
	async getRevocationShards(): Promise<ShardConfig> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/revocation-shards`, {
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

		const response = await fetch(`${API_BASE_URL}/api/admin/settings/revocation-shards`, {
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
	}
};
