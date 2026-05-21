/**
 * Settings Context Store (Svelte 5 Runes)
 *
 * Manages the settings scope context for the Admin UI.
 * Tracks current scope level (platform/tenant/client) and selected entity IDs.
 */

import { browser } from '$app/environment';
import { adminFetch } from '$lib/api/admin-request';
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
		tenantId: '',
		clientId: null,
		availableTenants: [],
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
			// Super admin / system admin has full access to everything
			super_admin: { platform: 'edit', tenant: 'edit', client: 'edit' },
			superadmin: { platform: 'edit', tenant: 'edit', client: 'edit' },
			system_admin: { platform: 'edit', tenant: 'edit', client: 'edit' },
			admin: { platform: 'view', tenant: 'edit', client: 'edit' },
			// Distributor admin can view platform, edit tenant/client
			distributor_admin: { platform: 'view', tenant: 'edit', client: 'edit' },
			// Org admin can only view tenant, edit client
			org_admin: { platform: 'none', tenant: 'view', client: 'edit' },
			// Viewer has read-only access
			viewer: { platform: 'view', tenant: 'view', client: 'view' }
		};

		// Find highest permission from user's roles
		let highestPermission: PermissionLevel = 'none';
		for (const role of userRoles) {
			// Normalize role name (handle variations like "Super Admin" -> "super_admin")
			const normalizedRole = role.toLowerCase().replace(/[\s-]+/g, '_');
			const perms = rolePermissions[normalizedRole] || rolePermissions[role];
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
		 * Resolve the effective tenant ID for API calls.
		 * Prefer the loaded tenant context and only use the session tenant as a
		 * last known-good fallback while the tenant list is unavailable.
		 */
		resolveTenantId(candidate?: string | null): string {
			return (
				candidate?.trim() ||
				state.tenantId ||
				state.availableTenants[0]?.id ||
				adminAuth.user?.tenantId ||
				''
			);
		},

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
			return this.resolveTenantId(state.tenantId);
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
			const resolvedTenantId = this.resolveTenantId(state.tenantId);
			return {
				level: state.currentLevel,
				tenantId: state.currentLevel !== 'platform' ? resolvedTenantId : undefined,
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
			const resolvedTenantId = this.resolveTenantId(tenantId);

			// Clear client selection and available clients immediately to prevent stale data
			state.clientId = null;
			state.availableClients = [];

			state.tenantId = resolvedTenantId;
			state.error = null;

			// Save to session storage
			if (browser) {
				sessionStorage.setItem('settings_tenant_id', resolvedTenantId);
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
				const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants`, {
					skipTenantHeader: true
				});

				if (response.ok) {
					const data = await response.json();
					state.availableTenants = (data.tenants || []).map((t: { id: string; name?: string }) => ({
						id: t.id,
						name: t.name || t.id
					}));
					state.tenantId = this.resolveTenantId(
						state.availableTenants.some((tenant) => tenant.id === state.tenantId)
							? state.tenantId
							: state.availableTenants[0]?.id
					);
					if (browser && state.tenantId) {
						sessionStorage.setItem('settings_tenant_id', state.tenantId);
					}
				} else {
					state.availableTenants = [];
					state.tenantId = this.resolveTenantId(
						state.tenantId && state.tenantId !== 'default'
							? state.tenantId
							: adminAuth.user?.tenantId
					);
					if (browser && state.tenantId) {
						sessionStorage.setItem('settings_tenant_id', state.tenantId);
					}
				}
			} catch (err) {
				console.warn('Failed to load tenants:', err);
				state.availableTenants = [];
				state.tenantId = this.resolveTenantId(
					state.tenantId && state.tenantId !== 'default' ? state.tenantId : adminAuth.user?.tenantId
				);
				if (browser && state.tenantId) {
					sessionStorage.setItem('settings_tenant_id', state.tenantId);
				}
			} finally {
				state.isLoading = false;
			}
		},

		/**
		 * Load available clients for current tenant
		 */
		async loadClients(): Promise<void> {
			const tenantId = this.resolveTenantId(state.tenantId);
			if (!browser || !tenantId) return;

			state.isLoading = true;
			state.error = null;

			try {
				const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants/${tenantId}/clients`, {
					tenantId
				});

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

			if (savedTenantId && savedTenantId !== 'default') {
				state.tenantId = savedTenantId;
			} else if (adminAuth.user?.tenantId) {
				state.tenantId = adminAuth.user.tenantId;
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
			state.tenantId = state.availableTenants[0]?.id || adminAuth.user?.tenantId || '';
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
