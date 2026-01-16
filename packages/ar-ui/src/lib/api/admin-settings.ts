/**
 * Admin Settings API Client
 *
 * Provides API calls for Settings API v2:
 * - Get all categories metadata
 * - Get category settings (with source info)
 * - Update category settings (optimistic locking)
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// Default tenant ID for single-tenant environments
const DEFAULT_TENANT_ID = 'default';

/**
 * Setting value source (priority: env > kv > default)
 */
export type SettingSource = 'env' | 'kv' | 'default';

/**
 * Individual setting value with source tracking
 */
export interface SettingValue {
	value: unknown;
	source: SettingSource;
	envValue?: unknown;
	kvValue?: unknown;
	defaultValue: unknown;
}

/**
 * Category settings response
 */
export interface CategorySettings {
	category: string;
	version: string; // For optimistic locking (ifMatch)
	values: Record<string, unknown>;
	sources: Record<string, SettingSource>;
}

/**
 * Setting metadata item
 */
export interface SettingMetaItem {
	key: string;
	type: 'number' | 'boolean' | 'string' | 'duration' | 'enum';
	default: unknown;
	envKey?: string;
	label: string;
	description: string;
	min?: number;
	max?: number;
	unit?: string;
	enum?: string[];
	restartRequired?: boolean;
	visibility?: 'public' | 'admin' | 'internal';
	dependsOn?: Array<{ key: string; value: unknown }>;
}

/**
 * Category metadata
 */
export interface CategoryMeta {
	category: string;
	label: string;
	description: string;
	settingsCount: number;
}

/**
 * Full category metadata with settings
 */
export interface CategoryMetaFull {
	category: string;
	label: string;
	description: string;
	visibility?: 'admin' | 'superadmin' | 'internal';
	writable?: boolean;
	settings: Record<string, SettingMetaItem>;
}

/**
 * Settings PATCH request
 */
export interface SettingsPatchRequest {
	ifMatch: string;
	set?: Record<string, unknown>;
	clear?: string[];
	disable?: string[];
}

/**
 * Settings PATCH result
 */
export interface SettingsPatchResult {
	applied: string[];
	cleared: string[];
	disabled: string[];
	rejected: Record<string, string>;
	newVersion: string;
}

/**
 * UI patch operation (for internal use)
 */
export type UIPatch =
	| { op: 'set'; key: string; value: unknown }
	| { op: 'clear'; key: string }
	| { op: 'disable'; key: string };

/**
 * Convert UI patches to API request format
 */
export function convertPatchesToAPIRequest(
	patches: UIPatch[]
): Omit<SettingsPatchRequest, 'ifMatch'> {
	const set: Record<string, unknown> = {};
	const clear: string[] = [];
	const disable: string[] = [];

	for (const patch of patches) {
		switch (patch.op) {
			case 'set':
				set[patch.key] = patch.value;
				break;
			case 'clear':
				clear.push(patch.key);
				break;
			case 'disable':
				disable.push(patch.key);
				break;
		}
	}

	return {
		set: Object.keys(set).length > 0 ? set : undefined,
		clear: clear.length > 0 ? clear : undefined,
		disable: disable.length > 0 ? disable : undefined
	};
}

/**
 * Settings conflict error
 */
export class SettingsConflictError extends Error {
	currentVersion: string;

	constructor(message: string, currentVersion: string) {
		super(message);
		this.name = 'SettingsConflictError';
		this.currentVersion = currentVersion;
	}
}

/**
 * Admin Settings API
 */
export const adminSettingsAPI = {
	/**
	 * Get all category metadata
	 * GET /api/admin/settings/meta
	 */
	async getCategories(): Promise<{ categories: CategoryMeta[] }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/meta`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch categories');
		}

		return response.json();
	},

	/**
	 * Get metadata for a specific category
	 * GET /api/admin/settings/meta/:category
	 */
	async getMeta(category: string): Promise<CategoryMetaFull> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/meta/${category}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Category '${category}' not found`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch category metadata');
		}

		return response.json();
	},

	/**
	 * Get settings for a tenant category
	 * GET /api/admin/tenants/:tenantId/settings/:category
	 */
	async getSettings(
		category: string,
		tenantId: string = DEFAULT_TENANT_ID
	): Promise<CategorySettings> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/tenants/${tenantId}/settings/${category}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Category '${category}' not found`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch settings');
		}

		return response.json();
	},

	/**
	 * Get platform settings (read-only)
	 * GET /api/admin/platform/settings/:category
	 */
	async getPlatformSettings(category: string): Promise<CategorySettings> {
		const response = await fetch(`${API_BASE_URL}/api/admin/platform/settings/${category}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Category '${category}' not found`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch platform settings');
		}

		return response.json();
	},

	/**
	 * Update settings for a tenant category (optimistic locking)
	 * PATCH /api/admin/tenants/:tenantId/settings/:category
	 */
	async updateSettings(
		category: string,
		request: SettingsPatchRequest,
		tenantId: string = DEFAULT_TENANT_ID
	): Promise<SettingsPatchResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/tenants/${tenantId}/settings/${category}`,
			{
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));

			// Handle conflict (409)
			if (response.status === 409) {
				// If currentVersion is not available, throw a generic error
				// instructing the user to refresh and retry
				if (!error.currentVersion) {
					throw new Error('Version conflict detected. Please refresh the page and try again.');
				}
				throw new SettingsConflictError(
					error.message || 'Settings were updated by someone else',
					error.currentVersion
				);
			}

			// Handle validation errors (400)
			if (response.status === 400) {
				throw new Error(error.message || 'Validation failed');
			}

			// Handle forbidden (403) - e.g., read-only category
			if (response.status === 403) {
				throw new Error(error.message || 'Settings are read-only');
			}

			throw new Error(error.message || error.error || 'Failed to update settings');
		}

		return response.json();
	}
};

/**
 * Known category names for type safety
 */
export const CATEGORY_NAMES = [
	// Tenant settings
	'oauth',
	'session',
	'security',
	'consent',
	'ciba',
	'rate-limit',
	'device-flow',
	'tokens',
	'external-idp',
	'credentials',
	'federation',
	// Client settings
	'client',
	// Cache settings
	'cache',
	// Feature Flags
	'feature-flags',
	// Limits
	'limits',
	// Tenant
	'tenant',
	// Verifiable Credentials
	'vc',
	// Discovery
	'discovery',
	// Plugin
	'plugin',
	// Assurance Levels (NIST SP 800-63-4)
	'assurance',
	// Platform settings (read-only)
	'infrastructure',
	'encryption'
] as const;

export type CategoryName = (typeof CATEGORY_NAMES)[number];

/**
 * Platform (read-only) categories
 * These categories contain infrastructure-level settings that should not be
 * modified via tenant settings API. They are managed at the platform level.
 */
export const PLATFORM_CATEGORIES: CategoryName[] = ['infrastructure', 'encryption'];

/**
 * Check if a category is platform-level (read-only)
 * Platform categories should use getPlatformSettings() instead of getSettings()
 */
export function isPlatformCategory(category: string): boolean {
	return PLATFORM_CATEGORIES.includes(category as CategoryName);
}

/**
 * Check if a setting is internal (locked, read-only)
 * Settings with visibility: 'internal' cannot be changed after initial setup
 */
export function isInternalSetting(settingMeta: SettingMetaItem): boolean {
	return settingMeta.visibility === 'internal';
}

// ============================================================================
// Scope-Aware Settings API Extensions
// ============================================================================

/**
 * Scope context for API calls
 */
export interface ScopeContext {
	level: 'platform' | 'tenant' | 'client';
	tenantId?: string;
	clientId?: string;
}

/**
 * Inherited setting value information
 */
export interface InheritedValue {
	value: unknown;
	source: SettingSource;
	scope: 'platform' | 'tenant' | 'client';
}

/**
 * Category settings with inheritance information
 */
export interface CategorySettingsWithInheritance extends CategorySettings {
	/** Inheritance chain for each setting */
	inheritance: Record<
		string,
		{
			effectiveValue: unknown;
			effectiveSource: SettingSource;
			platformValue?: InheritedValue;
			tenantValue?: InheritedValue;
			isOverridden: boolean;
		}
	>;
}

/**
 * Category scope information with user permissions
 */
export interface CategoryScopeInfo {
	allowedScopes: Array<'platform' | 'tenant' | 'client'>;
	userPermissions: Record<'platform' | 'tenant' | 'client', 'view' | 'edit' | 'none'>;
}

/**
 * Scope-aware Settings API extensions
 */
export const scopedSettingsAPI = {
	/**
	 * Get settings with inheritance information
	 * Returns settings with full inheritance chain for each value
	 */
	async getSettingsWithInheritance(
		category: string,
		scope: ScopeContext
	): Promise<CategorySettingsWithInheritance> {
		// Build query params for inheritance info
		const params = new URLSearchParams();
		params.set('includeInheritance', 'true');

		let url: string;
		switch (scope.level) {
			case 'platform':
				url = `${API_BASE_URL}/api/admin/platform/settings/${category}`;
				break;
			case 'tenant':
				url = `${API_BASE_URL}/api/admin/tenants/${scope.tenantId || DEFAULT_TENANT_ID}/settings/${category}`;
				break;
			case 'client':
				if (!scope.clientId) {
					throw new Error('Client ID is required for client scope');
				}
				url = `${API_BASE_URL}/api/admin/clients/${scope.clientId}/settings/${category}`;
				break;
		}

		const response = await fetch(`${url}?${params}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Category '${category}' not found`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch settings');
		}

		const data = await response.json();

		// If inheritance data not included, build it from available info
		if (!data.inheritance) {
			data.inheritance = {};
			for (const [key, value] of Object.entries(data.values)) {
				const source = data.sources[key] || 'default';
				data.inheritance[key] = {
					effectiveValue: value,
					effectiveSource: source,
					// Without parent value info, we cannot accurately determine override status
					// Set to false to avoid false positives in the UI
					isOverridden: false
				};
			}
		}

		return data;
	},

	/**
	 * Get category scope information with user permissions
	 */
	async getCategoryScopeInfo(category: string): Promise<CategoryScopeInfo> {
		const response = await fetch(`${API_BASE_URL}/api/admin/settings/meta/${category}/scope`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Category '${category}' not found`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch scope info');
		}

		return response.json();
	},

	/**
	 * Get client settings
	 * GET /api/admin/clients/:clientId/settings/:category
	 */
	async getClientSettings(clientId: string, category: string): Promise<CategorySettings> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/clients/${clientId}/settings/${category}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error(`Settings not found for client '${clientId}'`);
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.message || error.error || 'Failed to fetch client settings');
		}

		return response.json();
	},

	/**
	 * Update client settings (optimistic locking)
	 * PATCH /api/admin/clients/:clientId/settings/:category
	 */
	async updateClientSettings(
		clientId: string,
		category: string,
		request: SettingsPatchRequest
	): Promise<SettingsPatchResult> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/clients/${clientId}/settings/${category}`,
			{
				method: 'PATCH',
				headers: {
					'Content-Type': 'application/json'
				},
				credentials: 'include',
				body: JSON.stringify(request)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));

			if (response.status === 409) {
				if (!error.currentVersion) {
					throw new Error('Version conflict detected. Please refresh the page and try again.');
				}
				throw new SettingsConflictError(
					error.message || 'Settings were updated by someone else',
					error.currentVersion
				);
			}

			if (response.status === 400) {
				throw new Error(error.message || 'Validation failed');
			}

			if (response.status === 403) {
				throw new Error(error.message || 'Settings are read-only');
			}

			throw new Error(error.message || error.error || 'Failed to update client settings');
		}

		return response.json();
	},

	/**
	 * Get settings based on scope context
	 * Unified method that routes to appropriate endpoint
	 */
	async getSettingsForScope(category: string, scope: ScopeContext): Promise<CategorySettings> {
		switch (scope.level) {
			case 'platform':
				return adminSettingsAPI.getPlatformSettings(category);
			case 'tenant':
				return adminSettingsAPI.getSettings(category, scope.tenantId || DEFAULT_TENANT_ID);
			case 'client':
				if (!scope.clientId) {
					throw new Error('Client ID is required for client scope');
				}
				return this.getClientSettings(scope.clientId, category);
		}
	},

	/**
	 * Update settings based on scope context
	 * Unified method that routes to appropriate endpoint
	 */
	async updateSettingsForScope(
		category: string,
		scope: ScopeContext,
		request: SettingsPatchRequest
	): Promise<SettingsPatchResult> {
		switch (scope.level) {
			case 'platform':
				throw new Error('Platform settings are read-only');
			case 'tenant':
				return adminSettingsAPI.updateSettings(
					category,
					request,
					scope.tenantId || DEFAULT_TENANT_ID
				);
			case 'client':
				if (!scope.clientId) {
					throw new Error('Client ID is required for client scope');
				}
				return this.updateClientSettings(scope.clientId, category, request);
		}
	}
};
