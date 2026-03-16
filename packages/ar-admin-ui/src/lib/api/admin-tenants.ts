/**
 * Admin Tenants API Client
 *
 * Provides methods for managing tenants:
 * - List, get, create, update, delete tenants
 * - Set default tenant
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

export interface Tenant {
	id: string;
	name: string;
	description: string | null;
	is_active: boolean;
	is_default: boolean;
	created_at: number;
	updated_at: number;
}

export interface TenantListResponse {
	tenants: Tenant[];
	total: number;
	single_tenant_mode?: boolean;
	single_tenant_reason?: string | null;
}

export interface TenantDeleteResponse {
	job_id: string;
	status: 'pending';
	estimated_completion: number;
}

export interface CreateTenantRequest {
	id: string;
	name: string;
	description?: string;
}

export interface UpdateTenantRequest {
	name?: string;
	description?: string | null;
	is_active?: boolean;
}

// =============================================================================
// API Client
// =============================================================================

export const adminTenantsAPI = {
	/**
	 * List all tenants
	 */
	async list(): Promise<TenantListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/tenants`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch tenants');
		}
		return response.json();
	},

	/**
	 * Get a single tenant by ID
	 */
	async get(id: string): Promise<Tenant> {
		const response = await fetch(`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch tenant');
		}
		return response.json();
	},

	/**
	 * Create a new tenant
	 */
	async create(data: CreateTenantRequest): Promise<Tenant> {
		const response = await fetch(`${API_BASE_URL}/api/admin/tenants`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create tenant');
		}
		return response.json();
	},

	/**
	 * Update an existing tenant
	 * Note: id and is_default cannot be changed via this endpoint
	 */
	async update(id: string, data: UpdateTenantRequest): Promise<Tenant> {
		const response = await fetch(`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update tenant');
		}
		return response.json();
	},

	/**
	 * Schedule a tenant deletion as an async job.
	 * The tenant is immediately deactivated; all data is deleted by the Cron job.
	 * Returns 202 Accepted with the job ID.
	 * The 'default' tenant cannot be deleted.
	 */
	async delete(id: string): Promise<TenantDeleteResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`, {
			method: 'DELETE',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete tenant');
		}
		return response.json();
	},

	/**
	 * Set a tenant as the default tenant
	 */
	async setDefault(id: string): Promise<Tenant> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/set-default`,
			{
				method: 'POST',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to set default tenant');
		}
		return response.json();
	}
};
