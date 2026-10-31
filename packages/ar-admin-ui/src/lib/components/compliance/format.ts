/**
 * Labels and formats the compliance screens share. Unknown values from the server fall back to a
 * neutral rendering of the raw value (never HTML).
 */
import type { TranslationFunctions } from '$i18n/i18n-types';
import type {
	AccessReviewApplyStatus,
	AccessReviewStatus,
	ComplianceCheckId,
	ComplianceCheckStatus,
	ComplianceFramework,
	ComplianceReportStatus,
	ComplianceReportType,
	RetentionCategoryId
} from '$lib/api/admin-compliance';

export function statusBadgeClass(status: ComplianceCheckStatus): string {
	switch (status) {
		case 'compliant':
			return 'badge badge-success';
		case 'warning':
			return 'badge badge-warning';
		case 'non_compliant':
			return 'badge badge-danger';
		default:
			return 'badge badge-neutral';
	}
}

export function statusLabel(LL: TranslationFunctions, status: ComplianceCheckStatus): string {
	switch (status) {
		case 'compliant':
			return LL.admin_compliance_status_compliant();
		case 'warning':
			return LL.admin_compliance_status_warning();
		case 'non_compliant':
			return LL.admin_compliance_status_non_compliant();
		default:
			return LL.admin_compliance_status_not_applicable();
	}
}

export function frameworkLabel(framework: ComplianceFramework): string {
	switch (framework) {
		case 'gdpr':
			return 'GDPR';
		case 'soc2':
			return 'SOC 2';
		case 'iso27001':
			return 'ISO 27001';
		case 'pci_dss':
			return 'PCI DSS';
		default:
			return String(framework);
	}
}

export function checkLabel(LL: TranslationFunctions, id: ComplianceCheckId): string {
	const labels: Record<ComplianceCheckId, () => string> = {
		data_retention_enforced: LL.admin_compliance_check_data_retention_enforced,
		audit_logging: LL.admin_compliance_check_audit_logging,
		admin_mfa: LL.admin_compliance_check_admin_mfa,
		user_mfa_enforced: LL.admin_compliance_check_user_mfa_enforced,
		user_mfa_coverage: LL.admin_compliance_check_user_mfa_coverage,
		rbac_configured: LL.admin_compliance_check_rbac_configured
	};
	return labels[id]?.() ?? String(id);
}

export function reviewStatusLabel(LL: TranslationFunctions, status: AccessReviewStatus): string {
	switch (status) {
		case 'pending':
			return LL.admin_compliance_review_status_pending();
		case 'in_progress':
			return LL.admin_compliance_review_status_in_progress();
		case 'completed':
			return LL.admin_compliance_review_status_completed();
		case 'cancelled':
			return LL.admin_compliance_review_status_cancelled();
		default:
			return String(status);
	}
}

export function reviewStatusClass(status: AccessReviewStatus): string {
	switch (status) {
		case 'completed':
			return 'badge badge-success';
		case 'in_progress':
			return 'badge badge-info';
		case 'cancelled':
			return 'badge badge-neutral';
		default:
			return 'badge badge-warning';
	}
}

export function applyStatusLabel(
	LL: TranslationFunctions,
	status: AccessReviewApplyStatus | null
): string {
	switch (status) {
		case 'applying':
			return LL.admin_compliance_apply_applying();
		case 'applied':
			return LL.admin_compliance_apply_applied();
		case 'incomplete':
			return LL.admin_compliance_apply_incomplete();
		case 'failed':
			return LL.admin_compliance_apply_failed();
		case 'skipped':
			return LL.admin_compliance_apply_skipped();
		default:
			return '—';
	}
}

export function applyStatusClass(status: AccessReviewApplyStatus | null): string {
	switch (status) {
		case 'applied':
			return 'badge badge-success';
		case 'incomplete':
		case 'failed':
			return 'badge badge-danger';
		case 'applying':
			return 'badge badge-info';
		default:
			return 'badge badge-neutral';
	}
}

export function reportTypeLabel(LL: TranslationFunctions, type: ComplianceReportType): string {
	switch (type) {
		case 'access_review':
			return LL.admin_compliance_report_type_access_review();
		case 'mfa_coverage':
			return LL.admin_compliance_report_type_mfa_coverage();
		case 'compliance_status':
			return LL.admin_compliance_report_type_compliance_status();
		case 'audit_log':
			return LL.admin_compliance_report_type_audit_log();
		default:
			return String(type);
	}
}

export function reportStatusLabel(
	LL: TranslationFunctions,
	status: ComplianceReportStatus
): string {
	switch (status) {
		case 'generating':
			return LL.admin_compliance_report_status_generating();
		case 'completed':
			return LL.admin_compliance_report_status_completed();
		case 'failed':
			return LL.admin_compliance_report_status_failed();
		case 'expired':
			return LL.admin_compliance_report_status_expired();
		default:
			return String(status);
	}
}

export function reportStatusClass(status: ComplianceReportStatus): string {
	switch (status) {
		case 'generating':
			return 'badge badge-info';
		case 'completed':
			return 'badge badge-success';
		case 'failed':
			return 'badge badge-danger';
		default:
			return 'badge badge-neutral';
	}
}

export function categoryLabel(LL: TranslationFunctions, id: RetentionCategoryId): string {
	const labels: Record<RetentionCategoryId, () => string> = {
		audit_events: LL.admin_compliance_category_audit_events,
		audit_pii: LL.admin_compliance_category_audit_pii,
		check_api_audit: LL.admin_compliance_category_check_api_audit,
		user_tombstones: LL.admin_compliance_category_user_tombstones,
		compliance_reports: LL.admin_compliance_category_compliance_reports,
		lookup_directory: LL.admin_compliance_category_lookup_directory,
		diagnostic_logs: LL.admin_compliance_category_diagnostic_logs,
		sessions: LL.admin_compliance_category_sessions,
		refresh_tokens: LL.admin_compliance_category_refresh_tokens,
		authorization_codes: LL.admin_compliance_category_authorization_codes,
		access_tokens: LL.admin_compliance_category_access_tokens
	};
	return labels[id]?.() ?? String(id);
}

export function attentionReasonLabel(LL: TranslationFunctions, reason: string): string {
	const labels: Record<string, () => string> = {
		task_disabled: LL.admin_compliance_reason_task_disabled,
		task_failed: LL.admin_compliance_reason_task_failed,
		never_run: LL.admin_compliance_reason_never_run,
		tenant_run_failed: LL.admin_compliance_reason_tenant_run_failed,
		deleted_outside_authrim: LL.admin_compliance_reason_deleted_outside_authrim,
		not_deleted: LL.admin_compliance_reason_not_deleted,
		projection_pending: LL.admin_compliance_reason_projection_pending,
		no_absolute_limit: LL.admin_compliance_reason_no_absolute_limit,
		archive_not_deleted: LL.admin_compliance_reason_archive_not_deleted
	};
	return labels[reason]?.() ?? reason;
}

/** A retention as the largest whole unit it is (days, hours, minutes, seconds). */
export function formatRetention(
	LL: TranslationFunctions,
	retention: { value: number; unit: 'days' | 'seconds' }
): string {
	if (retention.unit === 'days') return LL.admin_compliance_days({ count: retention.value });
	return formatSeconds(LL, retention.value);
}

export function formatSeconds(LL: TranslationFunctions, seconds: number): string {
	if (seconds % 86400 === 0) return LL.admin_compliance_days({ count: seconds / 86400 });
	if (seconds % 3600 === 0) return LL.admin_compliance_hours({ count: seconds / 3600 });
	if (seconds % 60 === 0) return LL.admin_compliance_minutes({ count: seconds / 60 });
	return LL.admin_compliance_seconds({ count: seconds });
}

/** A date-time for display, in the viewer's locale (an empty value: a dash). */
export function formatDateTime(value: string | number | null | undefined): string {
	if (value === null || value === undefined || value === '') return '—';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
