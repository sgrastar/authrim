<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		type ComplianceStatus,
		type ComplianceFramework,
		type ComplianceCheckStatus,
		type AccessReview,
		type ComplianceReport,
		type DataRetentionStatus,
		type AccessReviewScope,
		type AccessReviewStatus,
		type ReportType,
		type ReportStatus
	} from '$lib/api/admin-compliance';
	import { adminDataRetentionAPI } from '$lib/api/admin-data-retention';
	import RetentionPolicyEditDialog from '$lib/components/RetentionPolicyEditDialog.svelte';
	import { Modal } from '$lib/components';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminTabs from '$lib/components/admin/AdminTabs.svelte';
	import type { AdminTabItem } from '$lib/components/admin/AdminTabs.svelte';
	import { formatDate, isValidDownloadUrl, SMALL_PAGE_SIZE, sanitizeText } from '$lib/utils';
	import { LL } from '$i18n/i18n-svelte';
	import { toast } from '$lib/toast';

	// State
	let loading = $state(true);
	let error = $state('');
	let complianceStatus = $state<ComplianceStatus | null>(null);
	let accessReviews = $state<AccessReview[]>([]);
	let reports = $state<ComplianceReport[]>([]);
	let dataRetention = $state<DataRetentionStatus | null>(null);

	// Tabs
	let activeTab = $state<'overview' | 'reviews' | 'reports' | 'retention'>('overview');

	// Tab definitions
	const TABS = [
		{ id: 'overview', getLabel: () => $LL.admin_compliance_tab_overview() },
		{ id: 'reviews', getLabel: () => $LL.admin_compliance_tab_reviews() },
		{ id: 'reports', getLabel: () => $LL.admin_compliance_tab_reports() },
		{ id: 'retention', getLabel: () => $LL.admin_compliance_tab_retention() }
	] as const;
	type ComplianceTab = (typeof TABS)[number]['id'];

	// Start Review Dialog
	let showStartReviewDialog = $state(false);
	let startingReview = $state(false);
	let startReviewError = $state('');
	let newReviewName = $state('');
	let newReviewScope = $state<AccessReviewScope>('all_users');
	let newReviewDueDate = $state('');

	// Retention Edit Dialog
	let showRetentionEditDialog = $state(false);
	let editingCategory = $state<string | null>(null);
	let editingRetentionDays = $state(0);
	let retentionActionError = $state('');

	// Cleanup Confirmation Dialog
	let showCleanupDialog = $state(false);
	let cleanupLoading = $state(false);
	let cleanupResult = $state<{ deleted: number; runId: string } | null>(null);

	// Framework Detail Modal
	interface FrameworkCheckDetail {
		id: string;
		name: string;
		description: string;
		status: 'implemented' | 'planned';
	}

	interface FrameworkDetail {
		fullName: string;
		description: string;
		checks: FrameworkCheckDetail[];
		inScope: string[];
		outOfScope: { item: string; reason: string }[];
	}

	function hasFrameworkDetail(framework: ComplianceFramework): boolean {
		return framework === 'GDPR' || framework === 'SOC2';
	}

	function getFrameworkDetail(framework: ComplianceFramework): FrameworkDetail | null {
		if (framework === 'GDPR') {
			return {
				fullName: $LL.admin_compliance_framework_gdpr_full_name(),
				description: $LL.admin_compliance_framework_gdpr_description(),
				checks: [
					{
						id: 'data_retention_policy',
						name: $LL.admin_compliance_check_data_retention_policy(),
						description: $LL.admin_compliance_check_data_retention_policy_desc(),
						status: 'implemented'
					},
					{
						id: 'right_to_erasure',
						name: $LL.admin_compliance_check_right_to_erasure(),
						description: $LL.admin_compliance_check_right_to_erasure_desc(),
						status: 'implemented'
					},
					{
						id: 'data_encryption',
						name: $LL.admin_compliance_check_data_encryption(),
						description: $LL.admin_compliance_check_data_encryption_desc(),
						status: 'implemented'
					},
					{
						id: 'consent_management',
						name: $LL.admin_compliance_check_consent_management(),
						description: $LL.admin_compliance_check_consent_management_desc(),
						status: 'planned'
					},
					{
						id: 'dsar_support',
						name: $LL.admin_compliance_check_dsar_support(),
						description: $LL.admin_compliance_check_dsar_support_desc(),
						status: 'planned'
					},
					{
						id: 'data_minimization',
						name: $LL.admin_compliance_check_data_minimization(),
						description: $LL.admin_compliance_check_data_minimization_desc(),
						status: 'planned'
					},
					{
						id: 'pii_access_audit',
						name: $LL.admin_compliance_check_pii_access_audit(),
						description: $LL.admin_compliance_check_pii_access_audit_desc(),
						status: 'planned'
					},
					{
						id: 'breached_password_detection',
						name: $LL.admin_compliance_check_breached_password_detection(),
						description: $LL.admin_compliance_check_breached_password_detection_desc(),
						status: 'planned'
					}
				],
				inScope: [
					$LL.admin_compliance_gdpr_scope_retention(),
					$LL.admin_compliance_gdpr_scope_erasure(),
					$LL.admin_compliance_gdpr_scope_encryption(),
					$LL.admin_compliance_gdpr_scope_auth_data(),
					$LL.admin_compliance_gdpr_scope_consent()
				],
				outOfScope: [
					{
						item: $LL.admin_compliance_gdpr_out_dpa(),
						reason: $LL.admin_compliance_gdpr_out_dpa_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_cookie(),
						reason: $LL.admin_compliance_gdpr_out_cookie_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_portability(),
						reason: $LL.admin_compliance_gdpr_out_portability_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_dpia(),
						reason: $LL.admin_compliance_gdpr_out_dpia_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_breach(),
						reason: $LL.admin_compliance_gdpr_out_breach_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_lawful_basis(),
						reason: $LL.admin_compliance_gdpr_out_lawful_basis_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_dpo(),
						reason: $LL.admin_compliance_gdpr_out_dpo_reason()
					},
					{
						item: $LL.admin_compliance_gdpr_out_transfer(),
						reason: $LL.admin_compliance_gdpr_out_transfer_reason()
					}
				]
			};
		}

		if (framework === 'SOC2') {
			return {
				fullName: $LL.admin_compliance_framework_soc2_full_name(),
				description: $LL.admin_compliance_framework_soc2_description(),
				checks: [
					{
						id: 'audit_logging',
						name: $LL.admin_compliance_check_audit_logging(),
						description: $LL.admin_compliance_check_audit_logging_desc(),
						status: 'implemented'
					},
					{
						id: 'rbac',
						name: $LL.admin_compliance_check_rbac(),
						description: $LL.admin_compliance_check_rbac_desc(),
						status: 'implemented'
					},
					{
						id: 'mfa_coverage',
						name: $LL.admin_compliance_check_mfa_coverage(),
						description: $LL.admin_compliance_check_mfa_coverage_desc(),
						status: 'implemented'
					},
					{
						id: 'encryption',
						name: $LL.admin_compliance_check_encryption(),
						description: $LL.admin_compliance_check_encryption_desc(),
						status: 'implemented'
					},
					{
						id: 'key_rotation',
						name: $LL.admin_compliance_check_key_rotation(),
						description: $LL.admin_compliance_check_key_rotation_desc(),
						status: 'planned'
					},
					{
						id: 'session_management',
						name: $LL.admin_compliance_check_session_management(),
						description: $LL.admin_compliance_check_session_management_desc(),
						status: 'planned'
					},
					{
						id: 'password_policy',
						name: $LL.admin_compliance_check_password_policy(),
						description: $LL.admin_compliance_check_password_policy_desc(),
						status: 'planned'
					},
					{
						id: 'rate_limiting',
						name: $LL.admin_compliance_check_rate_limiting(),
						description: $LL.admin_compliance_check_rate_limiting_desc(),
						status: 'planned'
					},
					{
						id: 'account_lockout',
						name: $LL.admin_compliance_check_account_lockout(),
						description: $LL.admin_compliance_check_account_lockout_desc(),
						status: 'planned'
					},
					{
						id: 'access_review',
						name: $LL.admin_compliance_check_access_review(),
						description: $LL.admin_compliance_check_access_review_desc(),
						status: 'planned'
					}
				],
				inScope: [
					$LL.admin_compliance_soc2_scope_audit(),
					$LL.admin_compliance_soc2_scope_rbac(),
					$LL.admin_compliance_soc2_scope_mfa(),
					$LL.admin_compliance_soc2_scope_encryption(),
					$LL.admin_compliance_soc2_scope_auth()
				],
				outOfScope: [
					{
						item: $LL.admin_compliance_soc2_out_formal_audit(),
						reason: $LL.admin_compliance_soc2_out_formal_audit_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_physical(),
						reason: $LL.admin_compliance_soc2_out_physical_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_network(),
						reason: $LL.admin_compliance_soc2_out_network_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_background(),
						reason: $LL.admin_compliance_soc2_out_background_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_vendor(),
						reason: $LL.admin_compliance_soc2_out_vendor_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_bcdr(),
						reason: $LL.admin_compliance_soc2_out_bcdr_reason()
					},
					{
						item: $LL.admin_compliance_soc2_out_change(),
						reason: $LL.admin_compliance_soc2_out_change_reason()
					}
				]
			};
		}

		return null;
	}

	let selectedFramework = $state<ComplianceFramework | null>(null);

	let selectedFrameworkDetail = $derived(
		selectedFramework ? getFrameworkDetail(selectedFramework) : null
	);

	let selectedFrameworkChecks = $derived(
		selectedFramework ? getFrameworkChecksWithStatus(selectedFramework) : []
	);

	let selectedFrameworkStatus = $derived(
		selectedFramework && complianceStatus
			? (complianceStatus.frameworks.find((f) => f.framework === selectedFramework) ?? null)
			: null
	);

	let implementedChecks = $derived(
		selectedFrameworkChecks.filter((c) => c.status === 'implemented')
	);

	let plannedChecks = $derived(selectedFrameworkChecks.filter((c) => c.status === 'planned'));

	// Helper functions for CSS classes
	function getComplianceStatusClass(status: string): string {
		switch (status) {
			case 'compliant':
				return 'compliance-status-badge compliant';
			case 'partial':
				return 'compliance-status-badge partial';
			case 'non_compliant':
				return 'compliance-status-badge non-compliant';
			default:
				return 'compliance-status-badge';
		}
	}

	function getComplianceStatusLabel(status: string): string {
		switch (status) {
			case 'compliant':
				return $LL.admin_compliance_status_compliant();
			case 'partial':
				return $LL.admin_compliance_status_partial();
			case 'non_compliant':
				return $LL.admin_compliance_status_non_compliant();
			case 'not_applicable':
				return $LL.admin_compliance_status_not_applicable();
			default:
				return status;
		}
	}

	function getComplianceProgressClass(status: string): string {
		switch (status) {
			case 'compliant':
				return 'progress-fill compliant';
			case 'partial':
				return 'progress-fill partial';
			case 'non_compliant':
				return 'progress-fill non-compliant';
			default:
				return 'progress-fill';
		}
	}

	function getReviewStatusClass(status: string): string {
		switch (status) {
			case 'pending':
				return 'review-status-badge pending';
			case 'in_progress':
				return 'review-status-badge in-progress';
			case 'completed':
				return 'review-status-badge completed';
			case 'cancelled':
				return 'review-status-badge cancelled';
			default:
				return 'review-status-badge';
		}
	}

	function getReportStatusClass(status: string): string {
		switch (status) {
			case 'pending':
				return 'report-status-badge pending';
			case 'generating':
				return 'report-status-badge generating';
			case 'completed':
				return 'report-status-badge completed';
			case 'failed':
				return 'report-status-badge failed';
			default:
				return 'report-status-badge';
		}
	}

	function getStatusValueClass(enabled: boolean): string {
		return enabled ? 'quick-stat-value enabled' : 'quick-stat-value disabled';
	}

	function getReviewStatusLabel(status: AccessReviewStatus): string {
		switch (status) {
			case 'pending':
				return $LL.admin_compliance_status_pending();
			case 'in_progress':
				return $LL.admin_compliance_status_in_progress();
			case 'completed':
				return $LL.admin_compliance_status_completed();
			case 'cancelled':
				return $LL.admin_compliance_status_cancelled();
		}
	}

	function getReportStatusLabel(status: ReportStatus): string {
		switch (status) {
			case 'pending':
				return $LL.admin_compliance_status_pending();
			case 'generating':
				return $LL.admin_compliance_status_generating();
			case 'completed':
				return $LL.admin_compliance_status_completed();
			case 'failed':
				return $LL.admin_compliance_status_failed();
		}
	}

	function formatEnabled(value: boolean): string {
		return value ? $LL.admin_compliance_enabled() : $LL.admin_compliance_disabled();
	}

	function formatYesNo(value: boolean): string {
		return value ? $LL.admin_compliance_yes() : $LL.admin_compliance_no();
	}

	function formatFrameworkDisplayName(framework: ComplianceFramework): string {
		switch (framework) {
			case 'SOC2':
				return 'SOC 2';
			case 'ISO27001':
				return 'ISO 27001';
			case 'PCI-DSS':
				return 'PCI DSS';
			default:
				return framework;
		}
	}

	async function loadData() {
		loading = true;
		error = '';

		const results = await Promise.allSettled([
			adminComplianceAPI.getStatus(),
			adminComplianceAPI.listAccessReviews({ limit: SMALL_PAGE_SIZE }),
			adminComplianceAPI.listReports({ limit: SMALL_PAGE_SIZE }),
			adminComplianceAPI.getDataRetentionStatus()
		]);

		// Collect all errors and update successful results
		const errors: string[] = [];
		const names = [
			$LL.admin_compliance_section_status(),
			$LL.admin_compliance_section_reviews(),
			$LL.admin_compliance_section_reports(),
			$LL.admin_compliance_section_retention()
		];

		if (results[0].status === 'fulfilled') {
			complianceStatus = results[0].value;
		} else {
			errors.push(
				$LL.admin_compliance_section_error({
					section: names[0],
					message:
						results[0].reason instanceof Error
							? results[0].reason.message
							: $LL.admin_compliance_load_failed()
				})
			);
		}

		if (results[1].status === 'fulfilled') {
			// Defensive check: ensure data is an array
			// Apply sanitization to prevent XSS
			accessReviews = Array.isArray(results[1].value.data)
				? results[1].value.data.map(sanitizeReview)
				: [];
		} else {
			errors.push(
				$LL.admin_compliance_section_error({
					section: names[1],
					message:
						results[1].reason instanceof Error
							? results[1].reason.message
							: $LL.admin_compliance_load_failed()
				})
			);
		}

		if (results[2].status === 'fulfilled') {
			// Defensive check: ensure data is an array
			reports = Array.isArray(results[2].value.data) ? results[2].value.data : [];
		} else {
			errors.push(
				$LL.admin_compliance_section_error({
					section: names[2],
					message:
						results[2].reason instanceof Error
							? results[2].reason.message
							: $LL.admin_compliance_load_failed()
				})
			);
		}

		if (results[3].status === 'fulfilled') {
			dataRetention = results[3].value;
		} else {
			errors.push(
				$LL.admin_compliance_section_error({
					section: names[3],
					message:
						results[3].reason instanceof Error
							? results[3].reason.message
							: $LL.admin_compliance_load_failed()
				})
			);
		}

		if (errors.length > 0) {
			error =
				errors.length === 1
					? errors[0]
					: $LL.admin_compliance_multiple_errors({ errors: errors.join('; ') });
		}

		loading = false;
	}

	onMount(() => {
		loadData();
	});

	function openStartReviewDialog() {
		newReviewName = '';
		newReviewScope = 'all_users';
		newReviewDueDate = '';
		startReviewError = '';
		showStartReviewDialog = true;
	}

	function closeStartReviewDialog() {
		showStartReviewDialog = false;
	}

	const MAX_REVIEW_NAME_LENGTH = 100;

	async function handleStartReview() {
		const trimmedName = newReviewName.trim();

		if (!trimmedName) {
			startReviewError = $LL.admin_compliance_review_name_required();
			return;
		}

		if (trimmedName.length > MAX_REVIEW_NAME_LENGTH) {
			startReviewError = $LL.admin_compliance_review_name_max({
				count: MAX_REVIEW_NAME_LENGTH
			});
			return;
		}

		startingReview = true;
		startReviewError = '';

		try {
			const review = await adminComplianceAPI.startAccessReview({
				name: newReviewName.trim(),
				scope: newReviewScope,
				due_date: newReviewDueDate || undefined
			});
			// Apply sanitization to prevent XSS
			accessReviews = [sanitizeReview(review), ...accessReviews];
			closeStartReviewDialog();
		} catch (e) {
			startReviewError =
				e instanceof Error ? e.message : $LL.admin_compliance_start_review_failed();
		} finally {
			startingReview = false;
		}
	}

	/**
	 * Sanitize and format scope value for display
	 * Only allows known scope values to prevent XSS
	 */
	function formatScopeDisplay(scope: string): string {
		const validScopes: Record<string, string> = {
			all_users: $LL.admin_compliance_scope_all_users(),
			role: $LL.admin_compliance_scope_role_label(),
			organization: $LL.admin_compliance_scope_organization_label(),
			inactive_users: $LL.admin_compliance_scope_inactive_users()
		};
		return validScopes[scope] || $LL.admin_compliance_scope_unknown();
	}

	/**
	 * Sanitize and format report type for display
	 * Only allows known report types to prevent XSS
	 * Must match API's ReportType definition
	 */
	function formatReportTypeDisplay(type: ReportType | string): string {
		const validTypes: Record<string, string> = {
			gdpr_dsar: $LL.admin_compliance_report_gdpr_dsar(),
			soc2_audit: $LL.admin_compliance_report_soc2_audit(),
			access_summary: $LL.admin_compliance_report_access_summary(),
			user_activity: $LL.admin_compliance_report_user_activity()
		};
		return validTypes[type] || $LL.admin_compliance_report_unknown();
	}

	// Global Escape key handler for dialogs
	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (selectedFramework) {
				closeFrameworkDetail();
			} else if (showStartReviewDialog) {
				closeStartReviewDialog();
			}
		}
	}

	// Sanitize API response fields to prevent XSS (defense in depth)
	function sanitizeReview(review: AccessReview): AccessReview {
		return {
			...review,
			name: sanitizeText(review.name)
		};
	}

	// Framework Detail functions
	function openFrameworkDetail(frameworkKey: ComplianceFramework) {
		selectedFramework = frameworkKey;
	}

	function closeFrameworkDetail() {
		selectedFramework = null;
	}

	function getFrameworkChecksWithStatus(frameworkKey: ComplianceFramework): Array<
		FrameworkCheckDetail & {
			liveStatus?: ComplianceCheckStatus;
			liveDetails?: string;
			checkedAt?: string;
		}
	> {
		const detail = getFrameworkDetail(frameworkKey);
		if (!detail || !complianceStatus) return [];

		const recentChecks = complianceStatus.recent_checks.filter((c) => c.framework === frameworkKey);

		return detail.checks.map((check) => {
			const liveCheck = recentChecks.find((rc) => rc.id === check.id);
			return {
				...check,
				liveStatus: liveCheck?.status,
				liveDetails: liveCheck?.details,
				checkedAt: liveCheck?.checked_at
			};
		});
	}

	// Retention Edit functions
	function openRetentionEditDialog(category: string, currentDays: number) {
		editingCategory = category;
		editingRetentionDays = currentDays;
		retentionActionError = '';
		showRetentionEditDialog = true;
	}

	function closeRetentionEditDialog() {
		showRetentionEditDialog = false;
		editingCategory = null;
	}

	async function handleRetentionSave(category: string, retentionDays: number) {
		await adminDataRetentionAPI.updateCategory(category, retentionDays);
		// Reload data to show updated values
		const freshData = await adminComplianceAPI.getDataRetentionStatus();
		dataRetention = freshData;
		toast.success($LL.admin_compliance_retention_updated());
		closeRetentionEditDialog();
	}

	// Cleanup functions
	function openCleanupDialog() {
		cleanupResult = null;
		retentionActionError = '';
		showCleanupDialog = true;
	}

	function closeCleanupDialog() {
		showCleanupDialog = false;
		cleanupResult = null;
	}

	async function executeCleanup() {
		cleanupLoading = true;
		retentionActionError = '';

		try {
			const result = await adminDataRetentionAPI.runCleanup();
			cleanupResult = {
				deleted: result.deleted_count || 0,
				runId: result.run_id
			};
			toast.success($LL.admin_compliance_cleanup_completed_count({ count: cleanupResult.deleted }));
			// Reload data to show updated values
			const freshData = await adminComplianceAPI.getDataRetentionStatus();
			dataRetention = freshData;
		} catch (err) {
			retentionActionError =
				err instanceof Error ? err.message : $LL.admin_compliance_cleanup_failed();
		} finally {
			cleanupLoading = false;
		}
	}

	function getCategoryDisplayName(category: string): string {
		switch (category) {
			case 'audit_logs':
				return $LL.admin_compliance_category_audit_logs();
			case 'session_data':
				return $LL.admin_compliance_category_session_data();
			case 'tombstones':
				return $LL.admin_compliance_category_tombstones();
			case 'auth_codes':
				return $LL.admin_compliance_category_auth_codes();
			case 'refresh_tokens':
				return $LL.admin_compliance_category_refresh_tokens();
			case 'access_tokens':
				return $LL.admin_compliance_category_access_tokens();
			default:
				return category.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
		}
	}

	function getCategoryDescription(category: string): string {
		switch (category) {
			case 'audit_logs':
				return $LL.admin_compliance_category_audit_logs_desc();
			case 'session_data':
				return $LL.admin_compliance_category_session_data_desc();
			case 'tombstones':
				return $LL.admin_compliance_category_tombstones_desc();
			case 'auth_codes':
				return $LL.admin_compliance_category_auth_codes_desc();
			case 'refresh_tokens':
				return $LL.admin_compliance_category_refresh_tokens_desc();
			case 'access_tokens':
				return $LL.admin_compliance_category_access_tokens_desc();
			default:
				return $LL.admin_compliance_category_unknown_desc();
		}
	}

	const tabItems = $derived<AdminTabItem[]>(
		TABS.map((tab) => ({
			id: tab.id,
			label: tab.getLabel()
		}))
	);

	function changeTab(id: string) {
		if (!TABS.some((tab) => tab.id === id)) return;
		error = '';
		activeTab = id as ComplianceTab;
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_compliance_title()}
		description={$LL.admin_compliance_description()}
	/>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<AdminTabs items={tabItems} active={activeTab} onChange={changeTab} />

	{#if loading}
		<div class="loading-state">{$LL.admin_compliance_loading()}</div>
	{:else if activeTab === 'overview' && complianceStatus}
		<!-- Overview Tab -->
		<div class="compliance-overview">
			<!-- Overall Status -->
			<div class="panel">
				<div class="compliance-overall-header">
					<div>
						<h2 class="section-title">{$LL.admin_compliance_overall_status()}</h2>
						<p class="text-muted">{$LL.admin_compliance_overall_status_description()}</p>
					</div>
					<div class={getComplianceStatusClass(complianceStatus.overall_status)}>
						{getComplianceStatusLabel(complianceStatus.overall_status)}
					</div>
				</div>
			</div>

			<!-- Frameworks Grid -->
			<div class="framework-grid">
				{#each complianceStatus.frameworks as framework (framework.framework)}
					{@const hasDetail = hasFrameworkDetail(framework.framework)}
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="framework-card"
						class:framework-card-clickable={hasDetail}
						onclick={() => hasDetail && openFrameworkDetail(framework.framework)}
						onkeydown={(e) =>
							e.key === 'Enter' && hasDetail && openFrameworkDetail(framework.framework)}
						role={hasDetail ? 'button' : undefined}
						tabindex={hasDetail ? 0 : undefined}
					>
						<div class="framework-card-header">
							<h3 class="framework-name">{formatFrameworkDisplayName(framework.framework)}</h3>
							<span class={getComplianceStatusClass(framework.status)}>
								{getComplianceStatusLabel(framework.status)}
							</span>
						</div>
						<div class="framework-progress">
							<div class="framework-progress-info">
								<span>{$LL.admin_compliance_progress()}</span>
								<span
									>{$LL.admin_compliance_checks_count({
										compliant: framework.compliant_checks,
										total: framework.total_checks
									})}</span
								>
							</div>
							<div class="progress-bar">
								<div
									class={getComplianceProgressClass(framework.status)}
									style="width: {framework.total_checks > 0
										? (framework.compliant_checks / framework.total_checks) * 100
										: 0}%"
								></div>
							</div>
						</div>
						{#if framework.issues.length > 0}
							<div class="framework-issues">
								<i class="i-ph-warning-circle" aria-hidden="true"></i>
								{$LL.admin_compliance_issue_count({
									count: framework.issues.length
								})}
							</div>
						{/if}
						<div class="framework-last-checked">
							{$LL.admin_compliance_last_checked()}
							{formatDate(framework.last_checked)}
						</div>
					</div>
				{/each}
			</div>

			<!-- Quick Stats -->
			<div class="quick-stats-grid">
				<div class="quick-stat-card">
					<div class="quick-stat-label">{$LL.admin_compliance_data_retention()}</div>
					<div class={getStatusValueClass(complianceStatus.data_retention?.enabled ?? false)}>
						{formatEnabled(complianceStatus.data_retention?.enabled ?? false)}
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">{$LL.admin_compliance_audit_log()}</div>
					<div class={getStatusValueClass(complianceStatus.audit_log?.enabled ?? false)}>
						{complianceStatus.audit_log?.retention_days
							? $LL.admin_compliance_days({ count: complianceStatus.audit_log.retention_days })
							: '-'}
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">{$LL.admin_compliance_mfa_coverage()}</div>
					<div class="quick-stat-value primary">
						{complianceStatus.mfa_enforcement?.coverage_percent ?? 0}%
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">{$LL.admin_compliance_encryption()}</div>
					<div
						class="quick-stat-value {complianceStatus.encryption?.at_rest &&
						complianceStatus.encryption?.in_transit
							? 'enabled'
							: 'partial'}"
					>
						{complianceStatus.encryption?.at_rest && complianceStatus.encryption?.in_transit
							? $LL.admin_compliance_full()
							: $LL.admin_compliance_status_partial()}
					</div>
				</div>
			</div>
		</div>
	{:else if activeTab === 'reviews'}
		<!-- Access Reviews Tab -->
		<div>
			<div class="tab-header-actions">
				<button class="btn btn-primary" onclick={openStartReviewDialog}>
					{$LL.admin_compliance_start_new_review()}
				</button>
			</div>

			{#if accessReviews.length === 0}
				<div class="empty-state">
					<p>{$LL.admin_compliance_no_reviews()}</p>
				</div>
			{:else}
				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_compliance_name()}</th>
							<th>{$LL.admin_compliance_scope()}</th>
							<th>{$LL.admin_compliance_review_progress()}</th>
							<th>{$LL.admin_compliance_section_status()}</th>
							<th>{$LL.admin_compliance_started()}</th>
						</tr>
					</thead>
					<tbody>
						{#each accessReviews as review (review.id)}
							<tr>
								<td>
									<div class="cell-primary">{review.name}</div>
								</td>
								<td>{formatScopeDisplay(review.scope)}</td>
								<td>
									<div class="review-progress-cell">
										<div class="progress-bar review-progress">
											<div
												class="progress-fill primary"
												style="width: {review.total_users > 0
													? (review.reviewed_users / review.total_users) * 100
													: 0}%"
											></div>
										</div>
										<span class="review-progress-text">
											{review.reviewed_users}/{review.total_users}
										</span>
									</div>
								</td>
								<td>
									<span class={getReviewStatusClass(review.status)}>
										{getReviewStatusLabel(review.status)}
									</span>
								</td>
								<td class="text-muted">{formatDate(review.started_at)}</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</div>
	{:else if activeTab === 'reports'}
		<!-- Reports Tab -->
		<div>
			{#if reports.length === 0}
				<div class="empty-state">
					<p>{$LL.admin_compliance_no_reports()}</p>
				</div>
			{:else}
				<AdminDataTable>
					<thead>
						<tr>
							<th>{$LL.admin_compliance_type()}</th>
							<th>{$LL.admin_compliance_section_status()}</th>
							<th>{$LL.admin_compliance_requested()}</th>
							<th>{$LL.admin_compliance_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each reports as report (report.id)}
							<tr>
								<td>
									<div class="cell-primary">{formatReportTypeDisplay(report.type)}</div>
								</td>
								<td>
									<span class={getReportStatusClass(report.status)}>
										{getReportStatusLabel(report.status)}
									</span>
								</td>
								<td class="text-muted">{formatDate(report.requested_at)}</td>
								<td>
									{#if report.status === 'completed' && report.download_url && isValidDownloadUrl(report.download_url)}
										<a
											href={report.download_url}
											target="_blank"
											rel="noopener noreferrer"
											class="link-primary"
										>
											{$LL.admin_compliance_download()}
										</a>
									{:else}
										<span class="text-muted">-</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</div>
	{:else if activeTab === 'retention' && dataRetention}
		<!-- Data Retention Tab -->
		<div class="retention-overview">
			<!-- Status Card -->
			<div class="panel">
				<h2 class="section-title">{$LL.admin_compliance_retention_policy()}</h2>
				<div class="retention-stats-grid">
					<div class="retention-stat">
						<div class="retention-stat-label">{$LL.admin_compliance_section_status()}</div>
						<div class={getStatusValueClass(dataRetention.enabled)}>
							{formatEnabled(dataRetention.enabled)}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">{$LL.admin_compliance_gdpr_compliant()}</div>
						<div class={getStatusValueClass(dataRetention.gdpr_compliant)}>
							{formatYesNo(dataRetention.gdpr_compliant)}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">{$LL.admin_compliance_last_cleanup()}</div>
						<div class="retention-stat-value">
							{dataRetention.last_cleanup ? formatDate(dataRetention.last_cleanup) : '-'}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">{$LL.admin_compliance_next_cleanup()}</div>
						<div class="retention-stat-value">
							{dataRetention.next_scheduled_cleanup
								? formatDate(dataRetention.next_scheduled_cleanup)
								: '-'}
						</div>
					</div>
				</div>
			</div>

			<!-- Categories -->
			{#if dataRetention.categories.length > 0}
				<div class="panel retention-categories-panel">
					<div class="retention-categories-header">
						<div>
							<h3 class="section-title">{$LL.admin_compliance_retention_categories()}</h3>
							<p class="text-muted">
								{$LL.admin_compliance_retention_categories_description()}
							</p>
						</div>
						<button class="btn btn-warning" onclick={openCleanupDialog}>
							<i class="i-ph-trash" aria-hidden="true"></i>
							{$LL.admin_compliance_run_cleanup()}
						</button>
					</div>
					<AdminDataTable width="wide">
						<thead>
							<tr>
								<th>{$LL.admin_compliance_category()}</th>
								<th class="table-cell--center">{$LL.admin_compliance_retention()}</th>
								<th class="text-right">{$LL.admin_compliance_records()}</th>
								<th>{$LL.admin_compliance_oldest_record()}</th>
								<th>{$LL.admin_compliance_next_cleanup()}</th>
								<th class="table-cell--center">{$LL.admin_compliance_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each dataRetention.categories as category (category.category)}
								<tr>
									<td>
										<div class="cell-primary">{getCategoryDisplayName(category.category)}</div>
										<div class="cell-secondary">{getCategoryDescription(category.category)}</div>
									</td>
									<td class="table-cell--center">
										<span class="retention-days-badge"
											>{$LL.admin_compliance_days({ count: category.retention_days })}</span
										>
									</td>
									<td class="text-right">{category.records_count.toLocaleString()}</td>
									<td class="text-muted">
										{category.oldest_record ? formatDate(category.oldest_record) : '-'}
									</td>
									<td class="text-muted">
										{category.next_cleanup ? formatDate(category.next_cleanup) : '-'}
									</td>
									<td class="table-cell--center">
										<button
											class="btn btn-ghost btn-sm"
											onclick={() =>
												openRetentionEditDialog(category.category, category.retention_days)}
										>
											{$LL.admin_compliance_edit()}
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				</div>

				<!-- Information Notice -->
				<div class="info-box">
					<i class="info-box-icon i-ph-info" aria-hidden="true"></i>
					<div>
						<div class="info-box-title">{$LL.admin_compliance_about_retention()}</div>
						<p class="info-box-text">
							{$LL.admin_compliance_about_retention_description()}
						</p>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</AdminPageShell>

<!-- Start Review Dialog -->
<Modal
	open={showStartReviewDialog}
	onClose={closeStartReviewDialog}
	title={$LL.admin_compliance_start_review_title()}
	size="md"
>
	{#if startReviewError}
		<div class="alert alert-error">{startReviewError}</div>
	{/if}

	<div class="form-group">
		<label for="review-name" class="form-label">{$LL.admin_compliance_review_name()}</label>
		<input
			type="text"
			id="review-name"
			class="form-input"
			bind:value={newReviewName}
			placeholder={$LL.admin_compliance_review_name_placeholder()}
		/>
	</div>

	<div class="form-group">
		<label for="review-scope" class="form-label">{$LL.admin_compliance_scope()}</label>
		<select id="review-scope" class="form-select" bind:value={newReviewScope}>
			<option value="all_users">{$LL.admin_compliance_scope_all_users()}</option>
			<option value="role">{$LL.admin_compliance_scope_role()}</option>
			<option value="organization">{$LL.admin_compliance_scope_organization()}</option>
			<option value="inactive_users">{$LL.admin_compliance_scope_inactive_users()}</option>
		</select>
	</div>

	<div class="form-group">
		<label for="review-due-date" class="form-label"
			>{$LL.admin_compliance_due_date_optional()}</label
		>
		<input type="date" id="review-due-date" class="form-input" bind:value={newReviewDueDate} />
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeStartReviewDialog} disabled={startingReview}>
			{$LL.admin_compliance_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleStartReview} disabled={startingReview}>
			{startingReview ? $LL.admin_compliance_starting() : $LL.admin_compliance_start_review()}
		</button>
	{/snippet}
</Modal>

<!-- Retention Policy Edit Dialog -->
<RetentionPolicyEditDialog
	open={showRetentionEditDialog}
	category={editingCategory}
	currentRetentionDays={editingRetentionDays}
	onClose={closeRetentionEditDialog}
	onSave={handleRetentionSave}
/>

<!-- Cleanup Confirmation Dialog -->
<Modal
	open={showCleanupDialog}
	onClose={closeCleanupDialog}
	title={cleanupResult
		? $LL.admin_compliance_cleanup_completed()
		: $LL.admin_compliance_cleanup_run()}
	size="md"
>
	{#if cleanupResult}
		<!-- Success State -->
		<div class="cleanup-success">
			<div class="cleanup-success-icon">✅</div>
			<p class="text-muted">
				{$LL.admin_compliance_cleanup_success()}
				<strong>{cleanupResult.deleted.toLocaleString()}</strong>
				{$LL.admin_compliance_cleanup_records_suffix()}
			</p>
			<p class="cleanup-run-id">
				{$LL.admin_compliance_cleanup_run_id()}
				{cleanupResult.runId}
			</p>
		</div>
	{:else}
		<!-- Confirmation State -->
		{#if retentionActionError}
			<div class="alert alert-error">{retentionActionError}</div>
		{/if}

		<div class="warning-box">
			<i class="warning-box-icon i-ph-warning-circle" aria-hidden="true"></i>
			<div>
				<div class="warning-box-title">{$LL.admin_compliance_cleanup_warning_title()}</div>
				<p class="warning-box-text">
					{$LL.admin_compliance_cleanup_warning_text()}
				</p>
			</div>
		</div>

		<p class="text-muted cleanup-confirm-text">
			{$LL.admin_compliance_cleanup_confirm()}
		</p>
	{/if}

	{#snippet footer()}
		{#if cleanupResult}
			<button class="btn btn-primary" onclick={closeCleanupDialog}>
				{$LL.admin_compliance_close()}
			</button>
		{:else}
			<button class="btn btn-secondary" onclick={closeCleanupDialog} disabled={cleanupLoading}>
				{$LL.admin_compliance_cancel()}
			</button>
			<button class="btn btn-danger" onclick={executeCleanup} disabled={cleanupLoading}>
				{cleanupLoading ? $LL.admin_compliance_deleting() : $LL.admin_compliance_delete_expired()}
			</button>
		{/if}
	{/snippet}
</Modal>

<!-- Framework Detail Modal -->
<Modal
	open={!!selectedFramework && !!selectedFrameworkDetail}
	onClose={closeFrameworkDetail}
	title={selectedFramework ? formatFrameworkDisplayName(selectedFramework) : ''}
	size="lg"
>
	{#snippet header()}
		<div>
			<h2 class="modal-title">
				{selectedFramework ? formatFrameworkDisplayName(selectedFramework) : ''}
			</h2>
			<p class="fw-detail-fullname">{selectedFrameworkDetail?.fullName ?? ''}</p>
		</div>
		{#if selectedFrameworkStatus}
			<span class={getComplianceStatusClass(selectedFrameworkStatus.status)}>
				{getComplianceStatusLabel(selectedFrameworkStatus.status)}
			</span>
		{/if}
	{/snippet}

	<div class="fw-detail-body">
		<p class="fw-detail-description">{selectedFrameworkDetail?.description ?? ''}</p>

		<!-- Compliance Checks (Implemented) -->
		{#if implementedChecks.length > 0}
			<div class="fw-detail-section">
				<h3 class="fw-detail-section-title">{$LL.admin_compliance_framework_checks()}</h3>
				<div class="fw-check-list">
					{#each implementedChecks as check (check.id)}
						<div class="fw-check-item">
							<div class="fw-check-info">
								<span
									class="fw-check-icon {check.liveStatus
										? 'check-' + check.liveStatus
										: 'check-implemented'}"
								>
									{#if check.liveStatus === 'partial'}⚠{:else if check.liveStatus === 'non_compliant'}✗{:else}✓{/if}
								</span>
								<div>
									<div class="fw-check-name">{check.name}</div>
									<div class="fw-check-desc">
										{check.liveDetails || check.description}
									</div>
								</div>
							</div>
							{#if check.liveStatus}
								<span class={getComplianceStatusClass(check.liveStatus)}>
									{getComplianceStatusLabel(check.liveStatus)}
								</span>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Planned Checks -->
		{#if plannedChecks.length > 0}
			<div class="fw-detail-section">
				<h3 class="fw-detail-section-title">{$LL.admin_compliance_planned_checks()}</h3>
				<div class="fw-check-list">
					{#each plannedChecks as check (check.id)}
						<div class="fw-check-item planned">
							<div class="fw-check-info">
								<span class="fw-check-icon check-planned">○</span>
								<div>
									<div class="fw-check-name">{check.name}</div>
									<div class="fw-check-desc">{check.description}</div>
								</div>
							</div>
							<span class="planned-badge">{$LL.admin_compliance_planned()}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- In Scope -->
		{#if selectedFrameworkDetail && selectedFrameworkDetail.inScope.length > 0}
			<div class="fw-detail-section">
				<h3 class="fw-detail-section-title">{$LL.admin_compliance_in_scope()}</h3>
				<ul class="scope-list in-scope">
					{#each selectedFrameworkDetail.inScope as item (item)}
						<li><span class="scope-icon in">✓</span> {item}</li>
					{/each}
				</ul>
			</div>
		{/if}

		<!-- Out of Scope -->
		{#if selectedFrameworkDetail && selectedFrameworkDetail.outOfScope.length > 0}
			<div class="fw-detail-section">
				<h3 class="fw-detail-section-title">{$LL.admin_compliance_out_of_scope()}</h3>
				<ul class="scope-list out-scope">
					{#each selectedFrameworkDetail.outOfScope as entry (entry.item)}
						<li>
							<span class="scope-icon out">○</span>
							<span>{entry.item}</span>
							<span class="scope-reason">— {entry.reason}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeFrameworkDetail}>
			{$LL.admin_compliance_close()}
		</button>
	{/snippet}
</Modal>

<style>
	.panel,
	.framework-grid,
	.framework-card,
	.compliance-overall-header,
	.framework-card-header,
	.framework-progress,
	.framework-progress-info,
	.quick-stats-grid,
	.quick-stat-card,
	.progress-bar,
	.fw-detail-body,
	.fw-check-item {
		box-sizing: border-box;
		min-width: 0;
	}

	.compliance-overview,
	.panel,
	.framework-grid,
	.framework-card {
		width: 100%;
		max-width: 100%;
	}

	.compliance-overview {
		grid-template-columns: minmax(0, 1fr);
	}

	.panel {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		color: var(--color-text);
	}

	.compliance-overall-header,
	.framework-card-header,
	.framework-progress-info {
		gap: 12px;
	}

	.compliance-status-badge {
		color: var(--color-text);
		white-space: nowrap;
	}

	.table-cell--center {
		text-align: center;
	}

	.framework-grid {
		grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
	}

	.framework-card {
		width: 100%;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		color: var(--color-text);
	}

	.quick-stats-grid {
		grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr));
	}

	.quick-stat-card {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		color: var(--color-text);
	}

	.quick-stat-label {
		color: var(--color-text-subtle);
	}

	.framework-name {
		color: var(--color-text);
	}

	.framework-progress-info,
	.framework-last-checked {
		color: var(--color-text-subtle);
	}

	.framework-issues,
	.btn-warning {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.framework-issues :global(i),
	.info-box-icon,
	.warning-box-icon,
	.btn-warning :global(i) {
		flex: none;
		width: 1em;
		height: 1em;
	}

	.progress-bar {
		background-color: var(--color-surface-muted);
	}

	/* Framework card clickable state */
	.framework-card-clickable {
		cursor: pointer;
		transition:
			border-color var(--transition-fast),
			box-shadow var(--transition-fast);
	}
	.framework-card-clickable:hover {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 1px var(--color-accent);
	}
	.framework-card-clickable:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	/* Framework Detail Modal */
	.fw-detail-fullname {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		margin: 4px 0 0 0;
	}
	.fw-detail-body {
		margin-bottom: 0;
	}
	.fw-detail-description {
		color: var(--color-text-muted);
		font-size: 0.875rem;
		line-height: 1.5;
		margin: 0 0 20px 0;
	}
	.fw-detail-section {
		margin-bottom: 20px;
	}
	.fw-detail-section:last-child {
		margin-bottom: 0;
	}
	.fw-detail-section-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0 12px 0;
		padding-bottom: 8px;
		border-bottom: 1px solid var(--color-border);
	}

	/* Check items */
	.fw-check-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.fw-check-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px;
		border-radius: var(--radius-md);
		background: var(--color-surface-muted);
		gap: 12px;
	}
	.fw-check-item.planned {
		opacity: 0.6;
	}
	.fw-check-info {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		flex: 1;
		min-width: 0;
	}
	.fw-check-icon {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		font-weight: 700;
		flex-shrink: 0;
		margin-top: 1px;
	}
	.check-compliant,
	.check-implemented {
		background: color-mix(in srgb, var(--color-success) 15%, transparent);
		color: var(--color-success);
	}
	.check-partial {
		background: color-mix(in srgb, var(--color-warning) 15%, transparent);
		color: var(--color-warning);
	}
	.check-non_compliant {
		background: color-mix(in srgb, var(--color-danger) 15%, transparent);
		color: var(--color-danger);
	}
	.check-planned {
		background: var(--color-surface);
		color: var(--color-text-subtle);
		border: 1px dashed var(--color-border);
	}
	.fw-check-name {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}
	.fw-check-desc {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
		margin-top: 2px;
	}
	.planned-badge {
		font-size: 0.75rem;
		color: var(--color-text-subtle);
		background: var(--color-surface);
		padding: 2px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--color-border);
		white-space: nowrap;
	}

	/* Scope lists */
	.scope-list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.scope-list li {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 0.875rem;
		color: var(--color-text);
		line-height: 1.4;
	}
	.scope-icon {
		flex-shrink: 0;
		font-size: 0.8125rem;
		font-weight: 600;
	}
	.scope-icon.in {
		color: var(--color-success);
	}
	.scope-icon.out {
		color: var(--color-text-subtle);
	}
	.scope-reason {
		color: var(--color-text-subtle);
		font-size: 0.8125rem;
	}

	@media (max-width: 520px) {
		.compliance-overall-header,
		.framework-card-header,
		.framework-progress-info,
		.fw-check-item,
		.scope-list li {
			align-items: flex-start;
			flex-direction: column;
		}

		.compliance-status-badge {
			align-self: flex-start;
		}

		.fw-check-info {
			width: 100%;
		}
	}
</style>
