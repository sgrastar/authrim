import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Compliance API client: the compliance status (checks and the facts behind them), access
 * reviews, compliance reports and data retention.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/** An API error with its code, so the page can say what to do about it. */
export class ComplianceAPIError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string | null,
		readonly body: Record<string, unknown> | null
	) {
		super(message);
	}
}

async function apiError(response: Response, fallbackMessage: string): Promise<ComplianceAPIError> {
	let body: Record<string, unknown> | null = null;
	try {
		body = (await response.json()) as Record<string, unknown>;
	} catch {
		// Not JSON.
	}
	const code = typeof body?.error === 'string' ? body.error : null;
	// Development shows the server's description; production keeps the fallback.
	const message =
		import.meta.env.DEV && typeof body?.error_description === 'string'
			? body.error_description
			: fallbackMessage;
	return new ComplianceAPIError(message, response.status, code, body);
}

async function getJson<T>(path: string, fallbackMessage: string): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, { credentials: 'include' });
	if (!response.ok) throw await apiError(response, fallbackMessage);
	return (await response.json()) as T;
}

async function sendJson<T>(
	method: 'POST' | 'PUT',
	path: string,
	body: unknown,
	fallbackMessage: string
): Promise<T> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		method,
		credentials: 'include',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!response.ok) throw await apiError(response, fallbackMessage);
	return (await response.json()) as T;
}

function query(params: Record<string, string | number | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : '';
}

export interface CursorPage<T> {
	data: T[];
	pagination: { has_more: boolean; next_cursor?: string };
}

// =============================================================================
// Compliance status
// =============================================================================

export type ComplianceCheckStatus = 'compliant' | 'warning' | 'non_compliant' | 'not_applicable';
export type ComplianceFramework = 'gdpr' | 'soc2' | 'iso27001' | 'pci_dss';
export type ComplianceCheckId =
	| 'data_retention_enforced'
	| 'audit_logging'
	| 'admin_mfa'
	| 'user_mfa_enforced'
	| 'user_mfa_coverage'
	| 'rbac_configured';

export interface ComplianceCheck {
	id: ComplianceCheckId;
	frameworks: ComplianceFramework[];
	status: ComplianceCheckStatus;
	facts: Record<string, number | string | boolean | null | string[]>;
}

export interface FrameworkSummary {
	framework: ComplianceFramework;
	status: ComplianceCheckStatus;
	compliant_checks: number;
	warning_checks: number;
	non_compliant_checks: number;
	not_applicable_checks: number;
	total_checks: number;
}

export interface RetentionAttention {
	category: RetentionCategoryId;
	reason: string;
}

export interface ComplianceStatus {
	tenant_id: string;
	overall_status: ComplianceCheckStatus;
	frameworks: FrameworkSummary[];
	checks: ComplianceCheck[];
	data_retention: { expired_records: number; attention: RetentionAttention[] };
	audit_log: {
		enabled: boolean;
		event_retention_days: number | null;
		pii_retention_days: number | null;
		total_entries: number | null;
		entries_last_30_days: number | null;
		hot_query_status: string;
	};
	mfa: {
		enforcement: {
			enforced: boolean;
			assurance_enabled: boolean;
			default_aal: string | null;
			scopes_requiring_mfa: string[];
		};
		admins: { admins: number; with_passkey: number };
		users: {
			users: number;
			with_passkey: number;
			with_totp: number;
			with_any: number;
			guests: number;
			deleting: number;
		};
	};
	access_control: { active_roles: number; users_with_roles: number };
	accounts: { pending_deletions: number };
	generated_at: string;
}

// =============================================================================
// Access reviews
// =============================================================================

export type AccessReviewScope = 'all_users' | 'role' | 'organization' | 'inactive_users';
export type AccessReviewStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface AccessReview {
	review_id: string;
	name: string;
	description: string | null;
	scope: AccessReviewScope;
	scope_value: string | null;
	inactive_days: number | null;
	status: AccessReviewStatus;
	reviewer_id: string | null;
	created_by: string | null;
	completed_by: string | null;
	progress: {
		total_items: number;
		reviewed_items: number;
		approved_items: number;
		revoked_items: number;
		completion_percent: number;
	};
	created_at: string | null;
	started_at: string | null;
	completed_at: string | null;
	due_date: string | null;
	overdue: boolean;
}

export interface AccessReviewDetail extends AccessReview {
	application: { applied: number; failed: number; pending_revocations: number };
}

export type AccessReviewDecision = 'approved' | 'revoked';
export type AccessReviewApplyStatus = 'applying' | 'applied' | 'incomplete' | 'failed' | 'skipped';

export interface AccessReviewItem {
	item_id: string;
	user_id: string;
	user: { email: string | null; name: string | null };
	permission_type: 'role' | 'organization' | 'account';
	permission_value: string;
	decision: AccessReviewDecision | null;
	decided_by: string | null;
	decided_at: string | null;
	justification: string | null;
	apply_status: AccessReviewApplyStatus | null;
	applied_at: string | null;
	apply_error: string | null;
}

export interface CreateAccessReviewInput {
	name: string;
	description?: string;
	scope: AccessReviewScope;
	scope_value?: string;
	due_date?: string;
	inactive_days?: number;
}

export interface CompleteAccessReviewResult {
	completed: boolean;
	applied: number;
	failed: number;
	remaining: number;
	review: AccessReview;
}

// =============================================================================
// Reports
// =============================================================================

export type ComplianceReportType =
	| 'access_review'
	| 'mfa_coverage'
	| 'compliance_status'
	| 'audit_log';
export type ComplianceReportStatus = 'generating' | 'completed' | 'failed' | 'expired';

export interface ComplianceReport {
	report_id: string;
	type: ComplianceReportType;
	name: string;
	status: ComplianceReportStatus;
	requested_by: string | null;
	parameters: Record<string, unknown> | null;
	format: 'csv' | 'json' | null;
	row_count: number | null;
	size_bytes: number | null;
	sha256: string | null;
	error: string | null;
	created_at: string;
	completed_at: string | null;
	expires_at: string | null;
	downloadable: boolean;
}

export interface CreateComplianceReportInput {
	type: ComplianceReportType;
	name?: string;
	parameters?: { review_id?: string; from?: string; to?: string };
}

// =============================================================================
// Data retention
// =============================================================================

export type RetentionCategoryId =
	| 'audit_events'
	| 'audit_pii'
	| 'check_api_audit'
	| 'user_tombstones'
	| 'compliance_reports'
	| 'lookup_directory'
	| 'diagnostic_logs'
	| 'sessions'
	| 'refresh_tokens'
	| 'authorization_codes'
	| 'access_tokens';

export type RetentionDeletion =
	| {
			kind: 'scheduled_task';
			task: string;
			enabled: boolean;
			disabled_reason: string | null;
			status: string;
			last_started_at: number | null;
			last_completed_at: number | null;
			last_error_code: string | null;
			next_run_at: number | null;
			tenant_last_run: { at: number; outcome: string } | null;
	  }
	| { kind: 'expiry' }
	| { kind: 'not_stored' }
	| { kind: 'not_deleted'; reason: string; projection?: 'current' | 'pending' };

export interface RetentionCategory {
	id: RetentionCategoryId;
	retention: { value: number; unit: 'days' | 'seconds' };
	source: { kind: string; category?: string; key?: string; level?: string; from?: string };
	edit: { kind: string; category?: string; key?: string; level?: string };
	deletion: RetentionDeletion;
	varies: 'by_route' | 'by_app' | 'by_sign_in_method' | 'by_request' | null;
	cap?: { kind: 'tenant_profile'; seconds: number };
	counts: { total: number; expired: number } | null;
	extension?: { per_refresh_seconds: number; absolute_limit_seconds: number | null };
	breakdown?: Array<{ key: string; seconds: number; fixed?: boolean }>;
	archive?: { deletion: 'not_deleted' };
}

export interface DataRetentionStatus {
	tenant_id: string;
	categories: RetentionCategory[];
	summary: { expired_records: number; attention: RetentionAttention[] };
	generated_at: string;
}

export interface UpdateLookupRetentionInput {
	retention_days: number;
	confirm_shortening?: boolean;
	expected_current_retention_days?: number;
}

// =============================================================================
// Client
// =============================================================================

export const adminComplianceAPI = {
	getStatus(): Promise<ComplianceStatus> {
		return getJson('/api/admin/compliance/status', 'Failed to load compliance status');
	},

	listAccessReviews(params: { limit?: number; cursor?: string; status?: string } = {}) {
		return getJson<CursorPage<AccessReview>>(
			`/api/admin/compliance/access-reviews${query(params)}`,
			'Failed to load access reviews'
		);
	},

	getAccessReview(id: string): Promise<AccessReviewDetail> {
		return getJson(
			`/api/admin/compliance/access-reviews/${encodeURIComponent(id)}`,
			'Failed to load the access review'
		);
	},

	listAccessReviewItems(
		id: string,
		params: { limit?: number; cursor?: string; decision?: string } = {}
	) {
		return getJson<CursorPage<AccessReviewItem>>(
			`/api/admin/compliance/access-reviews/${encodeURIComponent(id)}/items${query(params)}`,
			'Failed to load the review items'
		);
	},

	createAccessReview(input: CreateAccessReviewInput): Promise<AccessReview> {
		return sendJson(
			'POST',
			'/api/admin/compliance/access-reviews',
			input,
			'Failed to start the access review'
		);
	},

	decideAccessReviewItems(
		id: string,
		input: { item_ids: string[]; decision: AccessReviewDecision; justification?: string }
	): Promise<{ updated: number; unchanged: number; review: AccessReview }> {
		return sendJson(
			'POST',
			`/api/admin/compliance/access-reviews/${encodeURIComponent(id)}/decisions`,
			input,
			'Failed to record the decisions'
		);
	},

	completeAccessReview(id: string): Promise<CompleteAccessReviewResult> {
		return sendJson(
			'POST',
			`/api/admin/compliance/access-reviews/${encodeURIComponent(id)}/complete`,
			{},
			'Failed to complete the access review'
		);
	},

	cancelAccessReview(id: string): Promise<AccessReview> {
		return sendJson(
			'POST',
			`/api/admin/compliance/access-reviews/${encodeURIComponent(id)}/cancel`,
			{},
			'Failed to cancel the access review'
		);
	},

	listReports(params: { limit?: number; cursor?: string; status?: string; type?: string } = {}) {
		return getJson<CursorPage<ComplianceReport>>(
			`/api/admin/compliance/reports${query(params)}`,
			'Failed to load compliance reports'
		);
	},

	createReport(input: CreateComplianceReportInput): Promise<ComplianceReport> {
		return sendJson(
			'POST',
			'/api/admin/compliance/reports',
			input,
			'Failed to generate the report'
		);
	},

	/** The report's file, to save (the server checks its hash and audits the download). */
	async downloadReport(id: string): Promise<{ blob: Blob; filename: string }> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/compliance/reports/${encodeURIComponent(id)}/download`,
			{ credentials: 'include' }
		);
		if (!response.ok) throw await apiError(response, 'Failed to download the report');
		const disposition = response.headers.get('Content-Disposition') ?? '';
		const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? `compliance-report-${id}`;
		return { blob: await response.blob(), filename };
	},

	getDataRetentionStatus(): Promise<DataRetentionStatus> {
		return getJson('/api/admin/data-retention/status', 'Failed to load data retention');
	},

	updateLookupRetention(input: UpdateLookupRetentionInput) {
		return sendJson<Record<string, unknown>>(
			'PUT',
			'/api/admin/data-retention/categories/lookup_directory',
			input,
			'Failed to update the lookup directory retention'
		);
	}
};
