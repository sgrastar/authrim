/**
 * Admin Plugins API Client
 *
 * Provides methods for managing plugin configurations.
 * Plugins extend Authrim's functionality with custom authentication flows,
 * event handlers, and integrations.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Plugin source type
 */
export type PluginSourceType = 'builtin' | 'npm' | 'local' | 'unknown';

/**
 * Plugin source information
 */
export interface PluginSource {
	type: PluginSourceType;
	identifier?: string;
	npmVersion?: string;
}

/**
 * Plugin trust level
 */
export type PluginTrustLevel = 'official' | 'community';

/**
 * Plugin stability level
 */
export type PluginStability = 'stable' | 'beta' | 'alpha' | 'deprecated';

/**
 * Plugin author information
 */
export interface PluginAuthor {
	name: string;
	email?: string;
	url?: string;
}

/**
 * Plugin metadata
 */
export interface PluginMeta {
	name: string;
	description: string;
	icon?: string;
	category: string;
	documentationUrl?: string;
	author?: PluginAuthor;
	license?: string;
	tags?: string[];
	stability?: PluginStability;
}

/**
 * Plugin registry entry
 */
export interface PluginRegistryEntry {
	id: string;
	version: string;
	capabilities: string[];
	official: boolean;
	meta?: PluginMeta;
	source: PluginSource;
	trustLevel: PluginTrustLevel;
	registeredAt: number;
}

/**
 * Plugin health status
 */
export interface PluginHealthStatus {
	status: 'healthy' | 'degraded' | 'unhealthy';
	timestamp: number;
	message?: string;
}

/**
 * Plugin status information
 */
export interface PluginStatus {
	pluginId: string;
	enabled: boolean;
	configSource: 'kv' | 'env' | 'default';
	loadedAt?: number;
	lastHealthCheck?: PluginHealthStatus;
}

/**
 * Plugin with status information
 */
export interface PluginWithStatus extends PluginRegistryEntry {
	enabled: boolean;
	configSource: 'kv' | 'env' | 'default';
	loadedAt?: number;
	lastHealthCheck?: PluginHealthStatus;
}

/**
 * Plugin list response
 */
export interface PluginListResponse {
	plugins: PluginWithStatus[];
	total: number;
}

/**
 * Plugin detail response
 */
export interface PluginDetailResponse {
	plugin: PluginRegistryEntry;
	status: PluginStatus;
	config: Record<string, unknown>;
	configSchema?: Record<string, unknown>;
	disclaimer: string | null;
}

/**
 * Plugin health check response
 */
export interface PluginHealthResponse {
	status: 'healthy' | 'degraded' | 'unhealthy';
	message?: string;
	details?: Record<string, unknown>;
}

/**
 * List params for filtering
 */
export interface ListPluginsParams {
	category?: string;
	capability?: string;
	enabled?: boolean;
	trustLevel?: PluginTrustLevel;
}

/**
 * Common plugin capabilities
 */
export const PLUGIN_CAPABILITIES = [
	{ id: 'auth', name: 'Authentication', description: 'Custom authentication methods' },
	{ id: 'event', name: 'Event Handler', description: 'React to system events' },
	{ id: 'claims', name: 'Claims Provider', description: 'Add custom token claims' },
	{ id: 'storage', name: 'Storage', description: 'Custom data storage' },
	{ id: 'notification', name: 'Notification', description: 'Send notifications' },
	{ id: 'audit', name: 'Audit', description: 'Custom audit logging' }
];

/**
 * Common plugin categories
 */
export const PLUGIN_CATEGORIES = [
	{ id: 'authentication', name: 'Authentication' },
	{ id: 'mfa', name: 'Multi-Factor Authentication' },
	{ id: 'integration', name: 'Integration' },
	{ id: 'notification', name: 'Notification' },
	{ id: 'analytics', name: 'Analytics' },
	{ id: 'security', name: 'Security' },
	{ id: 'compliance', name: 'Compliance' }
];

export const adminPluginsAPI = {
	/**
	 * List all registered plugins
	 */
	async list(params: ListPluginsParams = {}): Promise<PluginListResponse> {
		const searchParams = new URLSearchParams();
		if (params.category) searchParams.set('category', params.category);
		if (params.capability) searchParams.set('capability', params.capability);
		if (params.enabled !== undefined) searchParams.set('enabled', params.enabled.toString());
		if (params.trustLevel) searchParams.set('trustLevel', params.trustLevel);

		const query = searchParams.toString();
		const response = await fetch(`${API_BASE_URL}/api/admin/plugins${query ? '?' + query : ''}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugins');
		}
		return response.json();
	},

	/**
	 * Get plugin details including configuration
	 */
	async get(id: string): Promise<PluginDetailResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugin');
		}
		return response.json();
	},

	/**
	 * Get plugin configuration
	 */
	async getConfig(id: string): Promise<Record<string, unknown>> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/config`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch plugin configuration'
			);
		}
		return response.json();
	},

	/**
	 * Update plugin configuration
	 */
	async updateConfig(
		id: string,
		config: Record<string, unknown>
	): Promise<Record<string, unknown>> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/config`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(config)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to update plugin configuration'
			);
		}
		return response.json();
	},

	/**
	 * Enable a plugin
	 */
	async enable(id: string): Promise<PluginStatus> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/enable`,
			{
				method: 'PUT',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to enable plugin');
		}
		return response.json();
	},

	/**
	 * Disable a plugin
	 */
	async disable(id: string): Promise<PluginStatus> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/disable`,
			{
				method: 'PUT',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to disable plugin');
		}
		return response.json();
	},

	/**
	 * Check plugin health
	 */
	async checkHealth(id: string): Promise<PluginHealthResponse> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/health`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to check plugin health');
		}
		return response.json();
	},

	/**
	 * Get plugin JSON Schema for UI form generation
	 */
	async getSchema(id: string): Promise<Record<string, unknown>> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/schema`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugin schema');
		}
		return response.json();
	}
};

/**
 * Helper: Get trust level badge color
 */
export function getTrustLevelColor(trustLevel: PluginTrustLevel): string {
	return trustLevel === 'official' ? '#22c55e' : '#f59e0b';
}

/**
 * Helper: Get stability badge color
 */
export function getStabilityColor(stability?: PluginStability): string {
	switch (stability) {
		case 'stable':
			return '#22c55e';
		case 'beta':
			return '#3b82f6';
		case 'alpha':
			return '#f59e0b';
		case 'deprecated':
			return '#ef4444';
		default:
			return '#6b7280';
	}
}

/**
 * Helper: Get health status color
 */
export function getHealthStatusColor(status?: 'healthy' | 'degraded' | 'unhealthy'): string {
	switch (status) {
		case 'healthy':
			return '#22c55e';
		case 'degraded':
			return '#f59e0b';
		case 'unhealthy':
			return '#ef4444';
		default:
			return '#6b7280';
	}
}
