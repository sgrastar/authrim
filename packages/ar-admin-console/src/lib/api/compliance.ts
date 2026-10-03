/**
 * Compliance API: the tenant's compliance status (checks read from what Authrim enforces, and the
 * facts behind them), access reviews, compliance reports and how long each kind of data is kept.
 *
 * Pages take a `ComplianceClient` rather than calling fetch, so Storybook and tests hand them an
 * in-memory one (`fake/compliance-fake.ts`).
 */
import { adminFetch, API_BASE_URL } from './admin-request';
import { ApiError, errorFromResponse } from './api-error';

export interface CursorPage<T> {
	data: T[];
	pagination: { has_more: boolean; next_cursor?: string };
}

export type CheckStatus = 'compliant' | 'warning' | 'non_compliant' | 'not_applicable';
export type Framework = 'gdpr' | 'soc2' | 'iso27001' | 'pci_dss';
export type CheckId =
	| 'data_retention_enforced'
	| 'audit_logging'
	| 'admin_mfa'
	| 'user_mfa_enforced'
	| 'user_mfa_coverage'
	| 'rbac_configured';

export interface ComplianceCheck {
	id: CheckId;
	frameworks: Framework[];
	status: CheckStatus;
	facts: Record<string, number | string | boolean | null | string[]>;
}

export interface FrameworkSummary {
	framework: Framework;
	status: CheckStatus;
	compliant_checks: number;
	warning_checks: number;
	non_compliant_checks: number;
	not_applicable_checks: number;
	total_checks: number;
}

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

export interface RetentionAttention {
	category: RetentionCategoryId;
	reason: string;
}

export interface ComplianceStatus {
	tenant_id: string;
	overall_status: CheckStatus;
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

export type ReviewScope = 'all_users' | 'role' | 'organization' | 'inactive_users';
export type ReviewStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface AccessReview {
	review_id: string;
	name: string;
	description: string | null;
	scope: ReviewScope;
	scope_value: string | null;
	inactive_days: number | null;
	status: ReviewStatus;
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

export type Decision = 'approved' | 'revoked';
export type ApplyStatus = 'applying' | 'applied' | 'incomplete' | 'failed' | 'skipped';

export interface ReviewItem {
	item_id: string;
	user_id: string;
	user: { email: string | null; name: string | null };
	permission_type: 'role' | 'organization' | 'account';
	permission_value: string;
	decision: Decision | null;
	decided_by: string | null;
	decided_at: string | null;
	justification: string | null;
	apply_status: ApplyStatus | null;
	applied_at: string | null;
	apply_error: string | null;
}

export interface NewReview {
	name: string;
	description?: string;
	scope: ReviewScope;
	scope_value?: string;
	due_date?: string;
	inactive_days?: number;
}

export interface CompleteResult {
	completed: boolean;
	applied: number;
	failed: number;
	remaining: number;
	review: AccessReview;
}

export type ReportType = 'access_review' | 'mfa_coverage' | 'compliance_status' | 'audit_log';
export type ReportStatus = 'generating' | 'completed' | 'failed' | 'expired';

export interface ComplianceReport {
	report_id: string;
	type: ReportType;
	name: string;
	status: ReportStatus;
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

export interface NewReport {
	type: ReportType;
	name?: string;
	parameters?: { review_id?: string; from?: string; to?: string };
}

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
	archive?: { deletion: 'not_deleted' };
}

export interface RetentionStatus {
	tenant_id: string;
	categories: RetentionCategory[];
	summary: { expired_records: number; attention: RetentionAttention[] };
	generated_at: string;
}

export interface LookupRetentionChange {
	retention_days: number;
	confirm_shortening?: boolean;
	expected_current_retention_days?: number;
}

export interface ComplianceClient {
	status(tenantId: string, signal?: AbortSignal): Promise<ComplianceStatus>;
	reviews(tenantId: string, cursor?: string): Promise<CursorPage<AccessReview>>;
	review(tenantId: string, id: string): Promise<AccessReviewDetail>;
	reviewItems(
		tenantId: string,
		id: string,
		options: { cursor?: string; decision?: 'pending' | Decision }
	): Promise<CursorPage<ReviewItem>>;
	createReview(tenantId: string, review: NewReview): Promise<AccessReview>;
	decide(
		tenantId: string,
		id: string,
		change: { item_ids: string[]; decision: Decision; justification?: string }
	): Promise<{ updated: number; unchanged: number; review: AccessReview }>;
	complete(tenantId: string, id: string): Promise<CompleteResult>;
	cancel(tenantId: string, id: string): Promise<AccessReview>;
	reports(tenantId: string, cursor?: string): Promise<CursorPage<ComplianceReport>>;
	createReport(tenantId: string, report: NewReport): Promise<ComplianceReport>;
	download(tenantId: string, id: string): Promise<{ blob: Blob; filename: string }>;
	retention(tenantId: string, signal?: AbortSignal): Promise<RetentionStatus>;
	setLookupRetention(tenantId: string, change: LookupRetentionChange): Promise<void>;
}

/** The API's own code for an error (`report_too_large`…), kept for a 409 too. */
export function errorCode(error: unknown): string {
	if (!(error instanceof ApiError)) return '';
	return typeof error.body.error === 'string' ? error.body.error : error.code;
}

function query(params: Record<string, string | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
	const text = search.toString();
	return text ? `?${text}` : '';
}

async function request<T>(
	tenantId: string,
	path: string,
	init: RequestInit & { json?: unknown } = {}
): Promise<T> {
	const { json, ...rest } = init;
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		...rest,
		tenantId,
		...(json !== undefined
			? { body: JSON.stringify(json), headers: { 'Content-Type': 'application/json' } }
			: {})
	});
	if (!response.ok) throw await errorFromResponse(response);
	return (await response.json()) as T;
}

const reviewPath = (id: string) => `/api/admin/compliance/access-reviews/${encodeURIComponent(id)}`;

export const httpCompliance: ComplianceClient = {
	status: (tenantId, signal) => request(tenantId, '/api/admin/compliance/status', { signal }),
	reviews: (tenantId, cursor) =>
		request(tenantId, `/api/admin/compliance/access-reviews${query({ limit: '20', cursor })}`),
	review: (tenantId, id) => request(tenantId, reviewPath(id)),
	reviewItems: (tenantId, id, options) =>
		request(
			tenantId,
			`${reviewPath(id)}/items${query({ limit: '50', cursor: options.cursor, decision: options.decision })}`
		),
	createReview: (tenantId, review) =>
		request(tenantId, '/api/admin/compliance/access-reviews', { method: 'POST', json: review }),
	decide: (tenantId, id, change) =>
		request(tenantId, `${reviewPath(id)}/decisions`, { method: 'POST', json: change }),
	complete: (tenantId, id) =>
		request(tenantId, `${reviewPath(id)}/complete`, { method: 'POST', json: {} }),
	cancel: (tenantId, id) =>
		request(tenantId, `${reviewPath(id)}/cancel`, { method: 'POST', json: {} }),
	reports: (tenantId, cursor) =>
		request(tenantId, `/api/admin/compliance/reports${query({ limit: '20', cursor })}`),
	createReport: (tenantId, report) =>
		request(tenantId, '/api/admin/compliance/reports', { method: 'POST', json: report }),
	async download(tenantId, id) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/compliance/reports/${encodeURIComponent(id)}/download`,
			{ tenantId }
		);
		if (!response.ok) throw await errorFromResponse(response);
		const disposition = response.headers.get('Content-Disposition') ?? '';
		const filename = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? `compliance-report-${id}`;
		return { blob: await response.blob(), filename };
	},
	retention: (tenantId, signal) =>
		request(tenantId, '/api/admin/data-retention/status', { signal }),
	async setLookupRetention(tenantId, change) {
		await request(tenantId, '/api/admin/data-retention/categories/lookup_directory', {
			method: 'PUT',
			json: change
		});
	}
};
