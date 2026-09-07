import { adminFetch } from '$lib/api/admin-request';
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
	backendKind?: 'dynamic_worker';
	capabilityManifestDigest?: string;
	activeVersionDigest?: string;
	credentialSlots?: Array<{ configKey: string; required: boolean }>;
	resources?: Array<{
		logicalResourceId: string;
		binding: string;
		kind: 'd1' | 'kv_namespace' | 'r2_bucket';
		access: 'read_only' | 'read_write';
		allowExisting: boolean;
	}>;
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
	configured: boolean;
	missingRequiredFields: string[];
	provisioning?: {
		operationId: string;
		state: 'pending' | 'blocked';
		kind: 'provisioning' | 'cleanup';
	};
	loadedAt?: number;
	lastHealthCheck?: PluginHealthStatus;
}

/**
 * Plugin with status information
 */
export interface PluginWithStatus extends PluginRegistryEntry {
	enabled: boolean;
	configSource: 'kv' | 'env' | 'default';
	configured: boolean;
	missingRequiredFields: string[];
	provisioning?: PluginStatus['provisioning'];
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

export interface PluginTestEmailResponse {
	success: boolean;
	pluginId: string;
	tenantId: string | null;
	to: string;
	messageId: string | null;
	deliveryState: 'delivered' | 'pending';
}

export interface PluginResourceSelection {
	logicalResourceId: string;
	mode: 'existing';
	providerResourceId: string;
	providerName: string;
}

export interface PluginResourceCleanup {
	operationId: string;
	environmentId: string;
	pluginInstallationId: string;
	tenantId: string;
	pluginId: string;
	sourceOperationId: string;
	lifecycleGeneration: number;
	reason: 'uninstall' | 'canceled_pre_activation';
	state:
		| 'requested'
		| 'removing_bindings'
		| 'quarantined'
		| 'deleting_resources'
		| 'verifying_absence'
		| 'succeeded'
		| 'blocked';
	drainNotBefore: number | null;
	managedResourceCount: number;
	detachedResourceCount: number;
	lastErrorCode: string | null;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
}

export interface ProviderProjectionJob {
	pluginId: string;
	revision: string;
	status: 'pending' | 'processing' | 'completed' | 'failed' | 'superseded';
	total: number;
	processed: number;
	succeeded: number;
	skipped: number;
	failed: number;
	lastErrorCode: string | null;
	updatedAt: number;
}

/**
 * List params for filtering
 */
export interface ListPluginsParams {
	category?: string;
	capability?: string;
	enabled?: boolean;
	trustLevel?: PluginTrustLevel;
	tenantId?: string;
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
	async getProviderProjectionStatus(): Promise<{ jobs: ProviderProjectionJob[] }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/platform/plugins/provider-projection/status`,
			{
				credentials: 'include',
				skipTenantHeader: true
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch provider projection status'
			);
		}
		return response.json();
	},

	/**
	 * List all registered plugins
	 */
	async list(params: ListPluginsParams = {}): Promise<PluginListResponse> {
		const searchParams = new URLSearchParams();
		if (params.category) searchParams.set('category', params.category);
		if (params.capability) searchParams.set('capability', params.capability);
		if (params.enabled !== undefined) searchParams.set('enabled', params.enabled.toString());
		if (params.trustLevel) searchParams.set('trustLevel', params.trustLevel);
		if (params.tenantId) searchParams.set('tenant_id', params.tenantId);

		const query = searchParams.toString();
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins${query ? '?' + query : ''}`,
			{
				tenantId: params.tenantId,
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugins');
		}
		return response.json();
	},

	/**
	 * Get plugin details including configuration
	 */
	async get(id: string, tenantId?: string): Promise<PluginDetailResponse> {
		const query = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}${query}`,
			{
				tenantId,
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugin');
		}
		return response.json();
	},

	/**
	 * Get plugin configuration
	 */
	async getConfig(id: string, tenantId?: string): Promise<Record<string, unknown>> {
		const query = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/config${query}`,
			{ credentials: 'include', tenantId }
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
		config: Record<string, unknown>,
		tenantId?: string
	): Promise<Record<string, unknown>> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/config`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				tenantId,
				body: JSON.stringify(tenantId ? { ...config, tenant_id: tenantId } : config)
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
	async enable(
		id: string,
		tenantId?: string,
		resourceSelections: readonly PluginResourceSelection[] = []
	): Promise<PluginStatus> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/enable`,
			{
				method: 'PUT',
				credentials: 'include',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify({
					...(tenantId ? { tenant_id: tenantId } : {}),
					...(resourceSelections.length > 0
						? {
								resource_selections: resourceSelections.map((selection) => ({
									logical_resource_id: selection.logicalResourceId,
									mode: selection.mode,
									provider_resource_id: selection.providerResourceId,
									provider_name: selection.providerName
								}))
							}
						: {})
				})
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
	async disable(id: string, tenantId?: string): Promise<PluginStatus> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/disable`,
			{
				method: 'PUT',
				credentials: 'include',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify(tenantId ? { tenant_id: tenantId } : {})
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to disable plugin');
		}
		return response.json();
	},

	async uninstall(
		id: string,
		tenantId: string,
		idempotencyKey: string
	): Promise<{ success: true; enabled: false; cleanup: PluginResourceCleanup | null }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/uninstall`,
			{
				method: 'POST',
				credentials: 'include',
				tenantId,
				includeJsonContentType: true,
				body: JSON.stringify({
					tenant_id: tenantId,
					idempotency_key: idempotencyKey,
					confirmation: 'UNINSTALL'
				})
			}
		);
		if (!response.ok) {
			const error: unknown = await response.json().catch(() => null);
			const message =
				error && typeof error === 'object' && !Array.isArray(error)
					? ((error as Record<string, unknown>).error_description ??
						(error as Record<string, unknown>).message)
					: null;
			throw new Error(typeof message === 'string' ? message : 'Failed to uninstall plugin');
		}
		return response.json() as Promise<{
			success: true;
			enabled: false;
			cleanup: PluginResourceCleanup | null;
		}>;
	},

	/**
	 * Check plugin health
	 */
	async checkHealth(id: string, tenantId?: string): Promise<PluginHealthResponse> {
		const query = tenantId ? `?tenant_id=${encodeURIComponent(tenantId)}` : '';
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/health${query}`,
			{ credentials: 'include', tenantId }
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
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/schema`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch plugin schema');
		}
		return response.json();
	},

	async sendTestEmail(
		id: string,
		payload: {
			to: string;
			tenantId?: string;
		}
	): Promise<PluginTestEmailResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/plugins/${encodeURIComponent(id)}/test-email`,
			{
				method: 'POST',
				credentials: 'include',
				tenantId: payload.tenantId,
				includeJsonContentType: true,
				body: JSON.stringify({
					to: payload.to,
					...(payload.tenantId ? { tenant_id: payload.tenantId } : {})
				})
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to send test email');
		}
		return response.json();
	}
};

/**
 * Helper: Get trust level badge color
 */
export function getTrustLevelColor(trustLevel: PluginTrustLevel): string {
	return trustLevel === 'official' ? 'var(--color-success)' : 'var(--color-warning)';
}

/**
 * Helper: Get stability badge color
 */
export function getStabilityColor(stability?: PluginStability): string {
	switch (stability) {
		case 'stable':
			return 'var(--color-success)';
		case 'beta':
			return 'var(--color-info)';
		case 'alpha':
			return 'var(--color-warning)';
		case 'deprecated':
			return 'var(--color-danger)';
		default:
			return 'var(--color-text-muted)';
	}
}

/**
 * Helper: Get health status color
 */
export function getHealthStatusColor(status?: 'healthy' | 'degraded' | 'unhealthy'): string {
	switch (status) {
		case 'healthy':
			return 'var(--color-success)';
		case 'degraded':
			return 'var(--color-warning)';
		case 'unhealthy':
			return 'var(--color-danger)';
		default:
			return 'var(--color-text-muted)';
	}
}
