/**
 * Admin Organizations API Client
 *
 * Provides methods for:
 * - Managing organizations and viewing hierarchy
 * - Managing organization domain mappings for JIT Provisioning
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Organization Types
// =============================================================================

/**
 * Basic organization information
 */
export interface Organization {
	id: string;
	tenant_id: string;
	name: string;
	display_name: string | null;
	parent_org_id: string | null;
	is_active: boolean;
	member_count?: number;
	created_at: number;
	updated_at: number;
}

/**
 * Organization node in hierarchy tree
 */
export interface OrganizationNode {
	id: string;
	name: string;
	display_name: string | null;
	parent_id: string | null;
	depth: number;
	is_active: boolean;
	member_count: number;
	children: OrganizationNode[];
}

/**
 * Organization hierarchy response
 */
export interface OrganizationHierarchyResponse {
	organization: OrganizationNode;
	summary: {
		total_organizations: number;
		total_members: number;
		max_depth: number;
	};
}

/**
 * Organization list response with pagination
 */
export interface OrganizationListResponse {
	organizations: Organization[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * Organization list filter params
 */
export interface ListOrganizationsParams {
	limit?: number;
	offset?: number;
	search?: string;
	parent_id?: string;
	is_active?: boolean;
}

// =============================================================================
// Domain Mapping Types
// =============================================================================

/**
 * Organization Domain Mapping
 */
export interface OrgDomainMapping {
	id: string;
	tenant_id: string;
	domain_hash: string;
	hash_version: number;
	org_id: string;
	auto_join_enabled: boolean;
	membership_type: 'member' | 'admin' | 'owner';
	auto_assign_role_id?: string;
	verified: boolean;
	verification_token?: string;
	verification_expires_at?: number;
	priority: number;
	is_active: boolean;
	created_at: number;
	updated_at: number;
	// Optional: returned when creating with domain
	domain?: string;
}

/**
 * List response with pagination
 */
export interface OrgDomainMappingListResponse {
	mappings: OrgDomainMapping[];
	total: number;
	limit: number;
	offset: number;
}

/**
 * Create Domain Mapping Request
 */
export interface CreateOrgDomainMappingRequest {
	domain: string;
	org_id: string;
	auto_join_enabled?: boolean;
	membership_type?: 'member' | 'admin' | 'owner';
	auto_assign_role_id?: string;
	verified?: boolean;
	priority?: number;
	is_active?: boolean;
}

/**
 * Update Domain Mapping Request
 */
export interface UpdateOrgDomainMappingRequest {
	auto_join_enabled?: boolean;
	membership_type?: 'member' | 'admin' | 'owner';
	auto_assign_role_id?: string;
	verified?: boolean;
	priority?: number;
	is_active?: boolean;
}

/**
 * DNS Verification Request
 */
export interface VerifyDomainRequest {
	id: string;
}

/**
 * DNS Verification Status
 */
export interface VerificationStatus {
	verified: boolean;
	record_name: string;
	expected_value: string;
	expires_at?: number;
	error?: string;
}

/**
 * List params for filtering
 */
export interface ListOrgDomainMappingsParams {
	limit?: number;
	offset?: number;
	org_id?: string;
	verified?: boolean;
	is_active?: boolean;
}

export const adminOrganizationsAPI = {
	// =========================================================================
	// Organization Methods
	// =========================================================================

	/**
	 * List organizations with optional filtering
	 */
	async listOrganizations(params: ListOrganizationsParams = {}): Promise<OrganizationListResponse> {
		const searchParams = new URLSearchParams();
		if (params.limit !== undefined) searchParams.set('limit', params.limit.toString());
		if (params.offset !== undefined) searchParams.set('offset', params.offset.toString());
		if (params.search) searchParams.set('search', params.search);
		if (params.parent_id) searchParams.set('parent_id', params.parent_id);
		if (params.is_active !== undefined) searchParams.set('is_active', params.is_active.toString());

		const query = searchParams.toString();
		const response = await fetch(
			`${API_BASE_URL}/api/admin/organizations${query ? '?' + query : ''}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch organizations');
		}
		return response.json();
	},

	/**
	 * Get organization details by ID
	 */
	async getOrganization(id: string): Promise<Organization> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/organizations/${encodeURIComponent(id)}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch organization');
		}
		return response.json();
	},

	/**
	 * Get organization hierarchy tree
	 * Returns the organization and all its descendants in a tree structure.
	 *
	 * @param orgId - Root organization ID
	 * @param maxDepth - Maximum depth to traverse (default: 10)
	 */
	async getHierarchy(orgId: string, maxDepth: number = 10): Promise<OrganizationHierarchyResponse> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/organizations/${encodeURIComponent(orgId)}/hierarchy?max_depth=${maxDepth}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch organization hierarchy'
			);
		}
		return response.json();
	},

	// =========================================================================
	// Domain Mapping Methods
	// =========================================================================

	/**
	 * List all domain mappings with optional filtering
	 */
	async list(params: ListOrgDomainMappingsParams = {}): Promise<OrgDomainMappingListResponse> {
		const searchParams = new URLSearchParams();
		if (params.limit !== undefined) searchParams.set('limit', params.limit.toString());
		if (params.offset !== undefined) searchParams.set('offset', params.offset.toString());
		if (params.org_id) searchParams.set('org_id', params.org_id);
		if (params.verified !== undefined) searchParams.set('verified', params.verified.toString());
		if (params.is_active !== undefined) searchParams.set('is_active', params.is_active.toString());

		const query = searchParams.toString();
		const response = await fetch(
			`${API_BASE_URL}/api/admin/org-domain-mappings${query ? '?' + query : ''}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch domain mappings'
			);
		}
		return response.json();
	},

	/**
	 * Get a single domain mapping by ID
	 */
	async get(id: string): Promise<OrgDomainMapping> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/org-domain-mappings/${encodeURIComponent(id)}`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to fetch domain mapping');
		}
		return response.json();
	},

	/**
	 * Get domain mappings for a specific organization
	 */
	async listByOrganization(orgId: string): Promise<OrgDomainMappingListResponse> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/organizations/${encodeURIComponent(orgId)}/domain-mappings`,
			{ credentials: 'include' }
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch organization domain mappings'
			);
		}
		return response.json();
	},

	/**
	 * Create a new domain mapping
	 */
	async create(data: CreateOrgDomainMappingRequest): Promise<OrgDomainMapping> {
		const response = await fetch(`${API_BASE_URL}/api/admin/org-domain-mappings`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to create domain mapping'
			);
		}
		return response.json();
	},

	/**
	 * Update an existing domain mapping
	 * Note: domain cannot be changed, create a new mapping instead
	 */
	async update(id: string, data: UpdateOrgDomainMappingRequest): Promise<OrgDomainMapping> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/org-domain-mappings/${encodeURIComponent(id)}`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				credentials: 'include',
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to update domain mapping'
			);
		}
		return response.json();
	},

	/**
	 * Delete a domain mapping
	 */
	async delete(id: string): Promise<{ success: boolean }> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/org-domain-mappings/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to delete domain mapping'
			);
		}
		return response.json();
	},

	/**
	 * Start DNS verification for a domain mapping
	 * Returns the TXT record details to add
	 */
	async startVerification(id: string): Promise<VerificationStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/org-domain-mappings/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ id })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to start domain verification'
			);
		}
		return response.json();
	},

	/**
	 * Confirm DNS verification (checks if TXT record is present)
	 */
	async confirmVerification(id: string): Promise<VerificationStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/org-domain-mappings/verify/confirm`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			credentials: 'include',
			body: JSON.stringify({ id })
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to confirm domain verification'
			);
		}
		return response.json();
	}
};
