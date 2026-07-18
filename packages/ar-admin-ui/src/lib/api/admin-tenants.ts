import { adminFetch } from '$lib/api/admin-request';

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
	tenant_code: string;
	name: string;
	description: string | null;
	lifecycle_state:
		| 'provisioning'
		| 'active'
		| 'suspended'
		| 'frozen'
		| 'migration_read_only'
		| 'deleting'
		| 'deleted'
		| 'restore_pending'
		| 'restore_validating';
	is_default: boolean;
	created_at: number;
	updated_at: number;
	provisioning_status?: 'active' | 'inactive' | 'provisioning_failed';
	provisioning_error?: string | null;
	provisioning_slot_id?: string | null;
	provisioning_updated_at?: number | null;
}

export type TenantLifecycleCommand =
	| 'suspend'
	| 'resume'
	| 'freeze'
	| 'unfreeze'
	| 'restore-validate';

export interface TenantListResponse {
	tenants: Tenant[];
	total: number;
	tenant_d1_pool?: {
		enabled: boolean;
		capacity?: number;
		available_slots?: number;
		reserved_slots?: number;
		assigned_slots?: number;
		pending_binding_slots?: number;
		unavailable_slots?: number;
		reset_required_slots?: number;
	};
	single_tenant_mode?: boolean;
	single_tenant_reason?: string | null;
}

export interface TenantDeleteResponse {
	job_id: string;
	status: 'pending';
	estimated_completion: number;
}

export interface TenantProvisioningCleanupResponse {
	status: 'cleaned';
	tenant_id: string;
	slot_id: string | null;
}

export interface TenantProvisioningRetryResponse extends Tenant {
	provisioning?: {
		mode: string;
		slot_id: string;
		smoke_test: 'passed';
		retry: 'succeeded';
	};
}

export interface CreateTenantRequest {
	id: string;
	tenant_code?: string;
	name: string;
	description?: string;
}

export interface TenantCloneOptions {
	settings: boolean;
	secret_settings: boolean;
	clients: boolean;
	client_credentials: boolean;
	roles: boolean;
	admin_access: boolean;
	webhooks: boolean;
	webhook_secrets: boolean;
}

export interface CloneTenantRequest extends CreateTenantRequest {
	copy: TenantCloneOptions;
}

export interface CloneTenantResponse extends Tenant {
	source_tenant_id: string;
	source_tenant_name: string;
	copy: TenantCloneOptions;
	cloned_items: {
		settings: number;
		secret_settings_skipped: number;
		unclassified_settings_skipped: number;
		clients: number;
		client_settings: number;
		client_contracts: number;
		client_web_origins: number;
		client_trust_policies: number;
		client_consent_overrides_skipped: number;
		client_flow_assignments_skipped: number;
		roles: number;
		role_assignment_rules: number;
		role_references_unresolved: number;
		role_assignment_rules_skipped: number;
		admin_roles: number;
		admin_role_assignments: number;
		admin_role_assignments_skipped: number;
		admin_role_inheritance_unresolved: number;
		webhooks: number;
		client_webhooks_skipped: number;
	};
	signing_keys: { copied: false; generated: true };
	warnings: string[];
}

export interface UpdateTenantRequest {
	name?: string;
	tenant_code?: string;
	description?: string | null;
}

export interface TenantLifecycleCommandRequest {
	expected_state: Tenant['lifecycle_state'];
	expected_updated_at: number;
	reason: string;
	break_glass?: boolean;
}

export interface TenantLifecycleCommandResponse {
	job_id: string;
	status: string;
	tenant_id: string;
	lifecycle_state: Tenant['lifecycle_state'];
	validation_required: boolean;
	idempotent_replay?: boolean;
}

export interface TenantLifecycleJob {
	id: string;
	status: string;
	progress: {
		stage?: string;
		checks?: Array<{ id: string; status: string; evidence?: string }>;
	} | null;
	result: Record<string, unknown> | null;
	config: { command?: TenantLifecycleCommand; reason?: string; source_state?: string } | null;
	error_message: string | null;
	attempt_count: number | null;
	max_attempts: number | null;
	next_run_at: number | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
}

// =============================================================================
// API Client
// =============================================================================

export const adminTenantsAPI = {
	/**
	 * List all tenants
	 */
	async list(): Promise<TenantListResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants`, {
			skipTenantHeader: true
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
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`,
			{
				skipTenantHeader: true
			}
		);

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
		const response = await adminFetch(`${API_BASE_URL}/api/admin/tenants`, {
			method: 'POST',
			includeJsonContentType: true,
			skipTenantHeader: true,
			body: JSON.stringify(data)
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to create tenant');
		}
		return response.json();
	},

	/** Create a tenant by copying selected configuration from an existing tenant. */
	async clone(
		sourceTenantId: string,
		data: CloneTenantRequest,
		idempotencyKey: string = crypto.randomUUID()
	): Promise<CloneTenantResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(sourceTenantId)}/clone`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to clone tenant');
		}
		return response.json();
	},

	/**
	 * Update an existing tenant
	 * Note: id and is_default cannot be changed via this endpoint
	 */
	async update(id: string, data: UpdateTenantRequest): Promise<Tenant> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`,
			{
				method: 'PATCH',
				includeJsonContentType: true,
				skipTenantHeader: true,
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to update tenant');
		}
		return response.json();
	},

	async lifecycleCommand(
		id: string,
		command: TenantLifecycleCommand,
		data: TenantLifecycleCommandRequest,
		idempotencyKey = crypto.randomUUID()
	): Promise<TenantLifecycleCommandResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/lifecycle/${command}`,
			{
				method: 'POST',
				includeJsonContentType: true,
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey },
				body: JSON.stringify(data)
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to change tenant lifecycle state'
			);
		}
		return response.json();
	},

	async lifecycleJobs(id: string): Promise<TenantLifecycleJob[]> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/lifecycle/jobs`,
			{ skipTenantHeader: true }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to load lifecycle jobs');
		}
		const body = (await response.json()) as { jobs?: TenantLifecycleJob[] };
		return body.jobs ?? [];
	},

	async retryLifecycleJob(id: string, jobId: string): Promise<void> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/lifecycle/jobs/${encodeURIComponent(jobId)}/retry`,
			{ method: 'POST', skipTenantHeader: true }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to retry lifecycle job');
		}
	},

	/**
	 * Schedule a tenant deletion as an async job.
	 * The tenant is immediately deactivated; all data is deleted by the Cron job.
	 * Returns 202 Accepted with the job ID.
	 * The 'default' tenant cannot be deleted.
	 */
	async delete(id: string): Promise<TenantDeleteResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}`,
			{
				method: 'DELETE',
				skipTenantHeader: true
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to delete tenant');
		}
		return response.json();
	},

	/**
	 * Delete a failed tenant provisioning draft.
	 */
	async cleanupProvisioning(id: string): Promise<TenantProvisioningCleanupResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/provisioning/cleanup`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to cleanup tenant provisioning draft'
			);
		}
		return response.json();
	},

	/**
	 * Retry a failed tenant provisioning draft.
	 */
	async retryProvisioning(id: string): Promise<TenantProvisioningRetryResponse> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/provisioning/retry`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to retry tenant provisioning'
			);
		}
		return response.json();
	},

	/**
	 * Set a tenant as the default tenant
	 */
	async setDefault(id: string): Promise<Tenant> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/set-default`,
			{
				method: 'POST',
				skipTenantHeader: true
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to set default tenant');
		}
		return response.json();
	}
};
