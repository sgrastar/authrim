/**
 * Admin Compliance API Client
 *
 * Provides methods for viewing compliance status, access reviews,
 * compliance reports, and data retention status.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Handle API errors safely - avoid leaking internal error details in production
 */
async function handleAPIError(response: Response, fallbackMessage: string): Promise<Error> {
	try {
		const errorBody = await response.json();
		// In development, show detailed error; in production, use fallback
		if (import.meta.env.DEV) {
			return new Error(errorBody.error_description || errorBody.error || fallbackMessage);
		}
	} catch {
		// JSON parsing failed, use fallback
	}
	return new Error(fallbackMessage);
}

/**
 * Compliance framework types
 */
export type ComplianceFramework = 'GDPR' | 'HIPAA' | 'SOC2' | 'ISO27001' | 'PCI-DSS' | 'CCPA';

/**
 * Compliance check status
 */
export type ComplianceCheckStatus = 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';

/**
 * Framework compliance summary
 */
export interface FrameworkSummary {
	framework: ComplianceFramework;
	status: ComplianceCheckStatus;
	compliant_checks: number;
	total_checks: number;
	last_checked: string;
	issues: string[];
}

/**
 * Recent compliance check result
 */
export interface ComplianceCheck {
	id: string;
	name: string;
	framework: ComplianceFramework;
	status: ComplianceCheckStatus;
	checked_at: string;
	details?: string;
}

/**
 * Data retention category status
 */
export interface RetentionCategoryStatus {
	category: string;
	retention_days: number;
	records_count: number;
	oldest_record?: string;
	next_cleanup?: string;
}

/**
 * Data retention status
 */
export interface DataRetentionStatus {
	enabled: boolean;
	categories: RetentionCategoryStatus[];
	gdpr_compliant: boolean;
	last_cleanup: string;
	next_scheduled_cleanup: string;
}

/**
 * Overall compliance status
 */
export interface ComplianceStatus {
	overall_status: ComplianceCheckStatus;
	frameworks: FrameworkSummary[];
	recent_checks: ComplianceCheck[];
	data_retention: {
		enabled: boolean;
		gdpr_compliant: boolean;
	};
	audit_log: {
		enabled: boolean;
		retention_days: number;
	};
	mfa_enforcement: {
		enabled: boolean;
		coverage_percent: number;
	};
	encryption: {
		at_rest: boolean;
		in_transit: boolean;
	};
	access_control: {
		rbac_enabled: boolean;
		last_review?: string;
	};
}

/**
 * Access review scope
 */
export type AccessReviewScope = 'all_users' | 'role' | 'organization' | 'inactive_users';

/**
 * Access review status
 */
export type AccessReviewStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/**
 * Access review entry
 */
export interface AccessReview {
	id: string;
	tenant_id: string;
	name: string;
	scope: AccessReviewScope;
	scope_target?: string;
	status: AccessReviewStatus;
	total_users: number;
	reviewed_users: number;
	started_by: string;
	started_at: string;
	completed_at?: string;
	due_date?: string;
}

/**
 * Compliance report type
 */
export type ReportType = 'gdpr_dsar' | 'soc2_audit' | 'access_summary' | 'user_activity';

/**
 * Compliance report status
 */
export type ReportStatus = 'pending' | 'generating' | 'completed' | 'failed';

/**
 * Compliance report entry
 */
export interface ComplianceReport {
	id: string;
	tenant_id: string;
	type: ReportType;
	status: ReportStatus;
	requested_by: string;
	requested_at: string;
	completed_at?: string;
	download_url?: string;
	expires_at?: string;
	parameters?: Record<string, unknown>;
}

/**
 * List response with cursor pagination
 */
export interface ListResponse<T> {
	data: T[];
	has_more: boolean;
	next_cursor?: string;
}

// =============================================================================
// Backend Response Types (for transformation)
// =============================================================================

/**
 * Backend framework summary (lowercase framework names, different field names)
 */
interface BackendFrameworkSummary {
	framework: string;
	status: string;
	compliant_checks: number;
	warning_checks?: number;
	non_compliant_checks?: number;
	not_applicable_checks?: number;
	total_checks: number;
	last_assessment: string | null;
}

/**
 * Backend compliance check (lowercase framework names)
 */
interface BackendComplianceCheck {
	id: string;
	name: string;
	description?: string;
	framework: string;
	status: string;
	last_checked: string;
	details?: string;
}

/**
 * Backend compliance status response
 */
interface BackendComplianceStatusResponse {
	tenant_id?: string;
	overall_status: string;
	frameworks: BackendFrameworkSummary[];
	recent_checks: BackendComplianceCheck[];
	data_retention: {
		policy_enabled?: boolean;
		enabled?: boolean;
		retention_days?: number | null;
		last_cleanup?: string | null;
		pending_deletions?: number;
		gdpr_compliant?: boolean;
	};
	audit_log: {
		enabled: boolean;
		retention_days: number;
		total_entries?: number;
		entries_last_30_days?: number;
	};
	mfa_status?: {
		enforced?: boolean;
		enabled?: boolean;
		users_with_mfa?: number;
		users_without_mfa?: number;
		mfa_coverage_percent?: number;
		coverage_percent?: number;
	};
	mfa_enforcement?: {
		enabled: boolean;
		coverage_percent: number;
	};
	encryption: {
		data_at_rest?: boolean;
		at_rest?: boolean;
		data_in_transit?: boolean;
		in_transit?: boolean;
		key_rotation_enabled?: boolean;
		last_key_rotation?: string | null;
	};
	access_control: {
		rbac_enabled: boolean;
		active_roles?: number;
		users_with_roles?: number;
		orphaned_permissions?: number;
		last_review?: string;
	};
	last_updated?: string;
}

/**
 * Backend access review response
 */
interface BackendAccessReview {
	review_id?: string;
	id?: string;
	tenant_id?: string;
	name: string;
	description?: string | null;
	scope: string;
	scope_value?: string | null;
	scope_target?: string;
	status: string;
	reviewer_id?: string;
	started_by?: string;
	progress?: {
		total_items: number;
		reviewed_items: number;
		approved_items?: number;
		revoked_items?: number;
		completion_percent?: number;
	};
	total_users?: number;
	reviewed_users?: number;
	total_items?: number;
	reviewed_items?: number;
	created_at?: string;
	started_at?: string | null;
	completed_at?: string | null;
	due_date?: string | null;
}

/**
 * Backend data retention category
 */
interface BackendRetentionCategory {
	category: string;
	retention_days: number;
	total_records?: number;
	records_count?: number;
	records_pending_deletion?: number;
	oldest_record?: string | null;
	oldest_record_date?: string | null;
	next_cleanup?: string | null;
	next_cleanup_date?: string | null;
	last_cleanup_date?: string | null;
	records_deleted_last_30_days?: number;
}

/**
 * Backend compliance report
 */
interface BackendComplianceReport {
	report_id?: string;
	id?: string;
	tenant_id?: string;
	type: string;
	name?: string;
	status: string;
	requested_by?: string;
	parameters?: Record<string, unknown> | string | null;
	result_url?: string | null;
	download_url?: string;
	error_message?: string | null;
	created_at?: string;
	requested_at?: string;
	completed_at?: string | null;
	expires_at?: string | null;
}

/**
 * Backend data retention status response
 */
interface BackendDataRetentionStatusResponse {
	tenant_id?: string;
	policy?: {
		enabled: boolean;
		default_retention_days?: number;
		cleanup_schedule?: string;
		last_cleanup_run?: string | null;
		next_cleanup_run?: string | null;
	};
	enabled?: boolean;
	categories: BackendRetentionCategory[];
	summary?: {
		total_records?: number;
		records_pending_deletion?: number;
		records_deleted_last_30_days?: number;
		storage_savings_estimate_mb?: number;
	};
	gdpr_compliance?: {
		right_to_erasure_supported?: boolean;
		anonymization_supported?: boolean;
		tombstone_retention_days?: number;
		pending_erasure_requests?: number;
	};
	gdpr_compliant?: boolean;
	last_cleanup?: string | null;
	next_scheduled_cleanup?: string | null;
	last_updated?: string;
}

// =============================================================================
// Transformation Functions
// =============================================================================

/**
 * Map backend framework string to frontend ComplianceFramework type
 */
function mapFramework(framework: string): ComplianceFramework {
	const map: Record<string, ComplianceFramework> = {
		gdpr: 'GDPR',
		hipaa: 'HIPAA',
		soc2: 'SOC2',
		iso27001: 'ISO27001',
		pci_dss: 'PCI-DSS',
		'pci-dss': 'PCI-DSS',
		ccpa: 'CCPA'
	};
	return map[framework.toLowerCase()] || (framework.toUpperCase() as ComplianceFramework);
}

/**
 * Map backend status string to ComplianceCheckStatus
 */
function mapStatus(status: string): ComplianceCheckStatus {
	const map: Record<string, ComplianceCheckStatus> = {
		compliant: 'compliant',
		non_compliant: 'non_compliant',
		partial: 'partial',
		warning: 'partial',
		not_applicable: 'not_applicable'
	};
	return map[status.toLowerCase()] || 'not_applicable';
}

/**
 * Transform backend compliance status to frontend format
 */
function transformComplianceStatus(raw: BackendComplianceStatusResponse): ComplianceStatus {
	return {
		overall_status: mapStatus(raw.overall_status),
		frameworks: raw.frameworks.map((f) => ({
			framework: mapFramework(f.framework),
			status: mapStatus(f.status),
			compliant_checks: f.compliant_checks,
			total_checks: f.total_checks,
			last_checked: f.last_assessment || new Date().toISOString(),
			issues:
				(f.non_compliant_checks || 0) > 0
					? [`${f.non_compliant_checks} non-compliant check(s)`]
					: (f.warning_checks || 0) > 0
						? [`${f.warning_checks} warning(s)`]
						: []
		})),
		recent_checks: raw.recent_checks.map((c) => ({
			id: c.id,
			name: c.name,
			framework: mapFramework(c.framework),
			status: mapStatus(c.status),
			checked_at: c.last_checked,
			details: c.details
		})),
		data_retention: {
			enabled: raw.data_retention.policy_enabled ?? raw.data_retention.enabled ?? false,
			gdpr_compliant: raw.data_retention.gdpr_compliant ?? false
		},
		audit_log: {
			enabled: raw.audit_log.enabled,
			retention_days: raw.audit_log.retention_days
		},
		mfa_enforcement: {
			enabled:
				raw.mfa_enforcement?.enabled ??
				raw.mfa_status?.enforced ??
				raw.mfa_status?.enabled ??
				false,
			coverage_percent:
				raw.mfa_enforcement?.coverage_percent ??
				raw.mfa_status?.mfa_coverage_percent ??
				raw.mfa_status?.coverage_percent ??
				0
		},
		encryption: {
			at_rest: raw.encryption.data_at_rest ?? raw.encryption.at_rest ?? false,
			in_transit: raw.encryption.data_in_transit ?? raw.encryption.in_transit ?? false
		},
		access_control: {
			rbac_enabled: raw.access_control.rbac_enabled,
			last_review: raw.access_control.last_review
		}
	};
}

/**
 * Transform backend access review to frontend format
 */
function transformAccessReview(raw: BackendAccessReview): AccessReview {
	return {
		id: raw.review_id ?? raw.id ?? '',
		tenant_id: raw.tenant_id ?? 'default',
		name: raw.name,
		scope: (raw.scope as AccessReviewScope) || 'all_users',
		scope_target: raw.scope_value ?? raw.scope_target,
		status: (raw.status as AccessReviewStatus) || 'pending',
		total_users: raw.progress?.total_items ?? raw.total_users ?? raw.total_items ?? 0,
		reviewed_users: raw.progress?.reviewed_items ?? raw.reviewed_users ?? raw.reviewed_items ?? 0,
		started_by: raw.reviewer_id ?? raw.started_by ?? '',
		started_at: raw.started_at ?? raw.created_at ?? '',
		completed_at: raw.completed_at ?? undefined,
		due_date: raw.due_date ?? undefined
	};
}

/**
 * Transform backend compliance report to frontend format
 */
function transformComplianceReport(raw: BackendComplianceReport): ComplianceReport {
	let parameters: Record<string, unknown> | undefined;
	if (raw.parameters) {
		if (typeof raw.parameters === 'string') {
			try {
				parameters = JSON.parse(raw.parameters) as Record<string, unknown>;
			} catch {
				// Invalid JSON, ignore
			}
		} else {
			parameters = raw.parameters;
		}
	}

	return {
		id: raw.report_id ?? raw.id ?? '',
		tenant_id: raw.tenant_id ?? 'default',
		type: raw.type as ReportType,
		status: raw.status as ReportStatus,
		requested_by: raw.requested_by ?? '',
		requested_at: raw.created_at ?? raw.requested_at ?? '',
		completed_at: raw.completed_at ?? undefined,
		download_url: raw.result_url ?? raw.download_url ?? undefined,
		expires_at: raw.expires_at ?? undefined,
		parameters
	};
}

/**
 * Transform backend data retention status to frontend format
 */
function transformDataRetentionStatus(
	raw: BackendDataRetentionStatusResponse
): DataRetentionStatus {
	return {
		enabled: raw.policy?.enabled ?? raw.enabled ?? false,
		categories: raw.categories.map((c) => ({
			category: c.category,
			retention_days: c.retention_days,
			records_count: c.total_records ?? c.records_count ?? 0,
			oldest_record: c.oldest_record_date ?? c.oldest_record ?? undefined,
			next_cleanup: c.next_cleanup_date ?? c.next_cleanup ?? undefined
		})),
		gdpr_compliant: raw.gdpr_compliance?.right_to_erasure_supported ?? raw.gdpr_compliant ?? false,
		last_cleanup: raw.policy?.last_cleanup_run ?? raw.last_cleanup ?? '',
		next_scheduled_cleanup: raw.policy?.next_cleanup_run ?? raw.next_scheduled_cleanup ?? ''
	};
}

/**
 * Admin Compliance API
 */
export const adminComplianceAPI = {
	/**
	 * Get comprehensive compliance status
	 */
	async getStatus(): Promise<ComplianceStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/compliance/status`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get compliance status');
		}

		// Transform backend response to expected frontend types
		const raw = (await response.json()) as BackendComplianceStatusResponse;
		return transformComplianceStatus(raw);
	},

	/**
	 * List access reviews
	 */
	async listAccessReviews(params?: {
		limit?: number;
		cursor?: string;
		status?: AccessReviewStatus;
	}): Promise<ListResponse<AccessReview>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		if (params?.status) searchParams.set('filter', `status=${params.status}`);

		const url = `${API_BASE_URL}/api/admin/compliance/access-reviews${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list access reviews');
		}

		// Transform backend response to expected frontend types
		const raw = (await response.json()) as {
			data: BackendAccessReview[];
			pagination?: { has_more: boolean; next_cursor?: string };
			has_more?: boolean;
			next_cursor?: string;
		};

		return {
			data: (raw.data || []).map(transformAccessReview),
			has_more: raw.pagination?.has_more ?? raw.has_more ?? false,
			next_cursor: raw.pagination?.next_cursor ?? raw.next_cursor
		};
	},

	/**
	 * Start a new access review
	 */
	async startAccessReview(params: {
		name: string;
		scope: AccessReviewScope;
		scope_target?: string;
		due_date?: string;
	}): Promise<AccessReview> {
		const response = await fetch(`${API_BASE_URL}/api/admin/compliance/access-reviews`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(params)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to start access review');
		}

		// Transform backend response to expected frontend types
		const raw = (await response.json()) as BackendAccessReview;
		return transformAccessReview(raw);
	},

	/**
	 * List compliance reports
	 */
	async listReports(params?: {
		limit?: number;
		cursor?: string;
		type?: ReportType;
	}): Promise<ListResponse<ComplianceReport>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);
		if (params?.type) searchParams.set('filter', `type=${params.type}`);

		const url = `${API_BASE_URL}/api/admin/compliance/reports${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list reports');
		}

		// Transform backend response to expected frontend types
		const raw = (await response.json()) as {
			data: BackendComplianceReport[];
			pagination?: { has_more: boolean; next_cursor?: string };
			has_more?: boolean;
			next_cursor?: string;
		};

		return {
			data: (raw.data || []).map(transformComplianceReport),
			has_more: raw.pagination?.has_more ?? raw.has_more ?? false,
			next_cursor: raw.pagination?.next_cursor ?? raw.next_cursor
		};
	},

	/**
	 * Get data retention status
	 */
	async getDataRetentionStatus(): Promise<DataRetentionStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/data-retention/status`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get data retention status');
		}

		// Transform backend response to expected frontend types
		const raw = (await response.json()) as BackendDataRetentionStatusResponse;
		return transformDataRetentionStatus(raw);
	}
};

/**
 * Get status badge color based on compliance status
 */
export function getComplianceStatusColor(status: ComplianceCheckStatus): string {
	switch (status) {
		case 'compliant':
			return '#22c55e';
		case 'non_compliant':
			return '#ef4444';
		case 'partial':
			return '#f59e0b';
		case 'not_applicable':
			return '#6b7280';
		default:
			return '#6b7280';
	}
}

/**
 * Get human-readable status label
 */
export function getComplianceStatusLabel(status: ComplianceCheckStatus): string {
	switch (status) {
		case 'compliant':
			return 'Compliant';
		case 'non_compliant':
			return 'Non-Compliant';
		case 'partial':
			return 'Partial';
		case 'not_applicable':
			return 'N/A';
		default:
			return status;
	}
}

/**
 * Get framework display name
 */
export function getFrameworkDisplayName(framework: ComplianceFramework): string {
	switch (framework) {
		case 'GDPR':
			return 'GDPR';
		case 'HIPAA':
			return 'HIPAA';
		case 'SOC2':
			return 'SOC 2';
		case 'ISO27001':
			return 'ISO 27001';
		case 'PCI-DSS':
			return 'PCI DSS';
		case 'CCPA':
			return 'CCPA';
		default:
			return framework;
	}
}
