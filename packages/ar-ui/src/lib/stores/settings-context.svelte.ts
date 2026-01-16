/**
 * Settings Context Store (Svelte 5 Runes)
 *
 * Manages the settings scope context for the Admin UI.
 * Tracks current scope level (platform/tenant/client) and selected entity IDs.
 */

import { browser } from '$app/environment';
import { adminAuth } from './admin-auth.svelte';

/**
 * Setting scope level
 */
export type SettingScopeLevel = 'platform' | 'tenant' | 'client';

/**
 * Simple entity reference (for tenant/client selection)
 */
export interface EntityRef {
	id: string;
	name: string;
}

/**
 * Settings context state
 */
interface SettingsContextState {
	/** Current scope level */
	currentLevel: SettingScopeLevel;
	/** Selected tenant ID (required for tenant/client scope) */
	tenantId: string;
	/** Selected client ID (only for client scope) */
	clientId: string | null;
	/** Available tenants for selection */
	availableTenants: EntityRef[];
	/** Available clients for the selected tenant */
	availableClients: EntityRef[];
	/** Loading state for tenant/client lists */
	isLoading: boolean;
	/** Error message */
	error: string | null;
}

/**
 * User permission level for a scope
 */
export type PermissionLevel = 'view' | 'edit' | 'none';

/**
 * Default tenant ID for single-tenant environments
 */
const DEFAULT_TENANT_ID = 'default';

/**
 * API base URL
 */
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Create settings context store
 */
function createSettingsContextStore() {
	// Reactive state using Svelte 5 $state rune
	let state = $state<SettingsContextState>({
		currentLevel: 'tenant',
		tenantId: DEFAULT_TENANT_ID,
		clientId: null,
		availableTenants: [{ id: DEFAULT_TENANT_ID, name: 'Default' }],
		availableClients: [],
		isLoading: false,
		error: null
	});

	/**
	 * Determine user's permission level for a scope based on roles
	 */
	function getPermissionForScope(scope: SettingScopeLevel, userRoles: string[]): PermissionLevel {
		// Permission mapping based on roles
		const rolePermissions: Record<string, Record<SettingScopeLevel, PermissionLevel>> = {
			system_admin: { platform: 'edit', tenant: 'edit', client: 'edit' },
			distributor_admin: { platform: 'view', tenant: 'edit', client: 'edit' },
			org_admin: { platform: 'none', tenant: 'view', client: 'edit' },
			viewer: { platform: 'view', tenant: 'view', client: 'view' }
		};

		// Find highest permission from user's roles
		let highestPermission: PermissionLevel = 'none';
		for (const role of userRoles) {
			const perms = rolePermissions[role];
			if (perms) {
				const perm = perms[scope];
				if (perm === 'edit') {
					return 'edit'; // Can't get higher
				}
				if (perm === 'view' && highestPermission === 'none') {
					highestPermission = 'view';
				}
			}
		}
		return highestPermission;
	}

	/**
	 * Check if user can access a scope level
	 */
	function canAccessScope(scope: SettingScopeLevel): boolean {
		const userRoles = adminAuth.user?.roles ?? [];
		return getPermissionForScope(scope, userRoles) !== 'none';
	}

	/**
	 * Check if user can edit at current scope
	 */
	function canEditAtCurrentScope(): boolean {
		const userRoles = adminAuth.user?.roles ?? [];
		return getPermissionForScope(state.currentLevel, userRoles) === 'edit';
	}

	return {
		/**
		 * Get current state (readonly)
		 */
		get current(): SettingsContextState {
			return state;
		},

		/**
		 * Get current scope level
		 */
		get currentLevel(): SettingScopeLevel {
			return state.currentLevel;
		},

		/**
		 * Get current tenant ID
		 */
		get tenantId(): string {
			return state.tenantId;
		},

		/**
		 * Get current client ID
		 */
		get clientId(): string | null {
			return state.clientId;
		},

		/**
		 * Get available tenants
		 */
		get availableTenants(): EntityRef[] {
			return state.availableTenants;
		},

		/**
		 * Get available clients
		 */
		get availableClients(): EntityRef[] {
			return state.availableClients;
		},

		/**
		 * Check if loading
		 */
		get isLoading(): boolean {
			return state.isLoading;
		},

		/**
		 * Get error message
		 */
		get error(): string | null {
			return state.error;
		},

		/**
		 * Get scope context for API calls
		 */
		get scopeContext(): { level: SettingScopeLevel; tenantId?: string; clientId?: string } {
			return {
				level: state.currentLevel,
				tenantId: state.currentLevel !== 'platform' ? state.tenantId : undefined,
				clientId: state.currentLevel === 'client' ? (state.clientId ?? undefined) : undefined
			};
		},

		/**
		 * Check permission for scope
		 */
		getPermissionForScope,

		/**
		 * Check if user can access a scope
		 */
		canAccessScope,

		/**
		 * Check if user can edit at current scope
		 */
		canEditAtCurrentScope,

		/**
		 * Get accessible scope levels for current user
		 */
		getAccessibleScopes(): SettingScopeLevel[] {
			const scopes: SettingScopeLevel[] = [];
			if (canAccessScope('platform')) scopes.push('platform');
			if (canAccessScope('tenant')) scopes.push('tenant');
			if (canAccessScope('client')) scopes.push('client');
			return scopes;
		},

		/**
		 * Set scope level
		 */
		setLevel(level: SettingScopeLevel): void {
			if (!canAccessScope(level)) {
				state.error = `You don't have permission to access ${level} settings`;
				return;
			}

			state.currentLevel = level;
			state.error = null;

			// Reset client selection when switching away from client scope
			if (level !== 'client') {
				state.clientId = null;
			}

			// Save to session storage for persistence
			if (browser) {
				sessionStorage.setItem('settings_scope_level', level);
			}
		},

		/**
		 * Set tenant ID
		 */
		async setTenantId(tenantId: string): Promise<void> {
			// Clear client selection and available clients immediately to prevent stale data
			state.clientId = null;
			state.availableClients = [];

			state.tenantId = tenantId;
			state.error = null;

			// Save to session storage
			if (browser) {
				sessionStorage.setItem('settings_tenant_id', tenantId);
				sessionStorage.removeItem('settings_client_id');
			}

			// Load clients for new tenant if at client scope
			if (state.currentLevel === 'client') {
				await this.loadClients();
			}
		},

		/**
		 * Set client ID
		 */
		setClientId(clientId: string | null): void {
			state.clientId = clientId;
			state.error = null;

			// Save to session storage
			if (browser) {
				if (clientId) {
					sessionStorage.setItem('settings_client_id', clientId);
				} else {
					sessionStorage.removeItem('settings_client_id');
				}
			}
		},

		/**
		 * Load available tenants
		 */
		async loadTenants(): Promise<void> {
			if (!browser) return;

			state.isLoading = true;
			state.error = null;

			try {
				const response = await fetch(`${API_BASE_URL}/api/admin/tenants`, {
					credentials: 'include'
				});

				if (response.ok) {
					const data = await response.json();
					state.availableTenants = (data.tenants || []).map((t: { id: string; name?: string }) => ({
						id: t.id,
						name: t.name || t.id
					}));
				} else {
					// Fallback to default tenant
					state.availableTenants = [{ id: DEFAULT_TENANT_ID, name: 'Default' }];
				}
			} catch (err) {
				console.warn('Failed to load tenants:', err);
				state.availableTenants = [{ id: DEFAULT_TENANT_ID, name: 'Default' }];
			} finally {
				state.isLoading = false;
			}
		},

		/**
		 * Load available clients for current tenant
		 */
		async loadClients(): Promise<void> {
			if (!browser || !state.tenantId) return;

			state.isLoading = true;
			state.error = null;

			try {
				const response = await fetch(
					`${API_BASE_URL}/api/admin/tenants/${state.tenantId}/clients`,
					{
						credentials: 'include'
					}
				);

				if (response.ok) {
					const data = await response.json();
					state.availableClients = (data.clients || []).map(
						(c: { client_id: string; client_name?: string }) => ({
							id: c.client_id,
							name: c.client_name || c.client_id
						})
					);
				} else {
					state.availableClients = [];
				}
			} catch (err) {
				console.warn('Failed to load clients:', err);
				state.availableClients = [];
			} finally {
				state.isLoading = false;
			}
		},

		/**
		 * Initialize store from session storage
		 */
		async initialize(): Promise<void> {
			if (!browser) return;

			// Restore from session storage
			const savedLevel = sessionStorage.getItem('settings_scope_level') as SettingScopeLevel | null;
			const savedTenantId = sessionStorage.getItem('settings_tenant_id');
			const savedClientId = sessionStorage.getItem('settings_client_id');

			if (savedLevel && canAccessScope(savedLevel)) {
				state.currentLevel = savedLevel;
			}

			if (savedTenantId) {
				state.tenantId = savedTenantId;
			}

			if (savedClientId) {
				state.clientId = savedClientId;
			}

			// Load tenants and clients
			await this.loadTenants();

			if (state.currentLevel === 'client') {
				await this.loadClients();
			}
		},

		/**
		 * Reset to defaults
		 */
		reset(): void {
			state.currentLevel = 'tenant';
			state.tenantId = DEFAULT_TENANT_ID;
			state.clientId = null;
			state.error = null;

			if (browser) {
				sessionStorage.removeItem('settings_scope_level');
				sessionStorage.removeItem('settings_tenant_id');
				sessionStorage.removeItem('settings_client_id');
			}
		}
	};
}

/**
 * Settings context store singleton
 */
export const settingsContext = createSettingsContextStore();
