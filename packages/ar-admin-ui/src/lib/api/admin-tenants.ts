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
	isolation_policy: 'shared_pool' | 'tenant_exclusive';
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
	operation_id?: string;
}

export type TenantProvisioningOperationStatus =
	| 'queued'
	| 'running'
	| 'waiting_retry'
	| 'blocked'
	| 'succeeded'
	| 'canceled';

export interface TenantProvisioningOperationStep {
	step_key:
		| 'request_accepted'
		| 'capacity_check'
		| 'reserve_default_route'
		| 'tenant_seed'
		| 'registry_publish'
		| 'tenant_smoke'
		| 'tenant_prepare'
		| 'lookup_activate'
		| 'tenant_active';
	status: 'queued' | 'running' | 'waiting_retry' | 'blocked' | 'succeeded' | 'skipped';
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_code: string | null;
	observed_resource_id: string | null;
	started_at: number | null;
	completed_at: number | null;
	updated_at: number;
}

export interface ControlProvisioningOperationStep {
	step_key: string;
	status:
		| 'queued'
		| 'running'
		| 'waiting_retry'
		| 'succeeded'
		| 'blocked'
		| 'canceled'
		| 'skipped'
		| 'rolled_back';
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_code: string | null;
	observed_resource_id: string | null;
	progress_current: number | null;
	progress_total: number | null;
	started_at: number | null;
	completed_at: number | null;
	updated_at: number;
}

export interface ControlProvisioningOperation {
	data_role: string;
	operation_id: string;
	status: TenantProvisioningOperationStatus;
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_code: string | null;
	updated_at: number;
	steps: ControlProvisioningOperationStep[];
}

export interface TenantProvisioningOperation {
	operation_id: string;
	tenant_id: string;
	operation_kind: 'create' | 'clone';
	source_tenant_id: string | null;
	isolation_policy: 'shared_pool' | 'tenant_exclusive';
	status: TenantProvisioningOperationStatus;
	current_step: TenantProvisioningOperationStep['step_key'];
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_code: string | null;
	created_at: number;
	updated_at: number;
	completed_at: number | null;
	preparation_result: Record<string, unknown> | null;
	capacity_operation_ids: Record<string, string>;
	capacity_operations?: ControlProvisioningOperation[];
	steps: TenantProvisioningOperationStep[];
}

export type TenantPlacementMigrationStepKey =
	| 'wait_control'
	| 'begin_route_cutover'
	| 'prepare_lookup'
	| 'prepare_alias'
	| 'commit_control'
	| 'publish_registry'
	| 'activate_alias'
	| 'activate_lookup'
	| 'verify_routes'
	| 'finalize_source'
	| 'complete';

export interface TenantPlacementMigrationOperation {
	operation_id: string;
	tenant_id: string;
	target_isolation_policy: 'tenant_exclusive';
	status: TenantProvisioningOperationStatus;
	current_step: TenantPlacementMigrationStepKey;
	attempt_count: number;
	next_attempt_at: number | null;
	last_error_code: string | null;
	lookup_progress: {
		prepared_rows: number;
		activated_rows: number;
		verified_rows: number;
	};
	steps: Array<{
		step: TenantPlacementMigrationStepKey;
		status: 'pending' | 'running' | 'waiting_retry' | 'blocked' | 'canceled' | 'completed';
	}>;
	created_at: number;
	started_at: number | null;
	completed_at: number | null;
	updated_at: number;
	control_status: 'available' | 'unavailable';
	control: {
		state: string;
		writeFenceState: 'inactive' | 'requested' | 'active' | 'released';
		routeCutoverStarted: boolean;
		canCancel: boolean;
		canApprovePurge: boolean;
		sourceRetentionExpiresAt: number | null;
		lastErrorCode: string | null;
	} | null;
}

export interface CreateTenantResponse extends Tenant {
	provisioning?: TenantProvisioningOperation & { mode: 'control-plane' };
}

export interface CreateTenantRequest {
	id: string;
	tenant_code?: string;
	name: string;
	description?: string;
	isolation_policy?: 'shared_pool' | 'tenant_exclusive';
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

export interface CloneTenantCompletedResponse extends Tenant {
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

export interface CloneTenantProvisioningResponse extends Tenant {
	source_tenant_id: string;
	source_tenant_name: string;
	copy: TenantCloneOptions;
	provisioning: TenantProvisioningOperation & { mode: 'control-plane' };
}

export type CloneTenantResponse = CloneTenantCompletedResponse | CloneTenantProvisioningResponse;

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
	async create(data: CreateTenantRequest): Promise<CreateTenantResponse> {
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

	async provisioning(id: string): Promise<TenantProvisioningOperation> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/provisioning`,
			{ skipTenantHeader: true }
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to load tenant provisioning status'
			);
		}
		return response.json();
	},

	async latestPlacementMigration(id: string): Promise<TenantPlacementMigrationOperation | null> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/placement-migrations/latest`,
			{ skipTenantHeader: true }
		);
		if (response.status === 404) return null;
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to load placement migration status'
			);
		}
		return response.json();
	},

	async startPlacementMigration(
		id: string,
		idempotencyKey = crypto.randomUUID()
	): Promise<TenantPlacementMigrationOperation> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/placement-migrations`,
			{
				method: 'POST',
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey }
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to start placement migration'
			);
		}
		return response.json();
	},

	async cancelPlacementMigration(
		id: string,
		operationId: string,
		idempotencyKey = crypto.randomUUID()
	): Promise<TenantPlacementMigrationOperation> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/placement-migrations/${encodeURIComponent(operationId)}/cancel`,
			{
				method: 'POST',
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey }
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to cancel placement migration'
			);
		}
		return response.json();
	},

	async approvePlacementMigrationPurge(
		id: string,
		operationId: string,
		idempotencyKey = crypto.randomUUID()
	): Promise<TenantPlacementMigrationOperation> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/tenants/${encodeURIComponent(id)}/placement-migrations/${encodeURIComponent(operationId)}/approve-purge`,
			{
				method: 'POST',
				skipTenantHeader: true,
				headers: { 'Idempotency-Key': idempotencyKey }
			}
		);
		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || error.message || 'Failed to approve source purge');
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
	async retryProvisioning(id: string): Promise<TenantProvisioningOperation> {
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
