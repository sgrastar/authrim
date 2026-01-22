<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		getFrameworkDisplayName,
		type ComplianceStatus,
		type AccessReview,
		type ComplianceReport,
		type DataRetentionStatus,
		type AccessReviewScope
	} from '$lib/api/admin-compliance';
	import {
		adminDataRetentionAPI,
		getCategoryDisplayName,
		getCategoryDescription
	} from '$lib/api/admin-data-retention';
	import RetentionPolicyEditDialog from '$lib/components/RetentionPolicyEditDialog.svelte';
	import { formatDate, isValidDownloadUrl, SMALL_PAGE_SIZE, sanitizeText } from '$lib/utils';

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
		{ id: 'overview', label: 'Overview' },
		{ id: 'reviews', label: 'Access Reviews' },
		{ id: 'reports', label: 'Reports' },
		{ id: 'retention', label: 'Data Retention' }
	] as const;

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
				return 'Compliant';
			case 'partial':
				return 'Partial';
			case 'non_compliant':
				return 'Non-Compliant';
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
		const names = ['Status', 'Access Reviews', 'Reports', 'Data Retention'];

		if (results[0].status === 'fulfilled') {
			complianceStatus = results[0].value;
		} else {
			errors.push(
				`${names[0]}: ${results[0].reason instanceof Error ? results[0].reason.message : 'Failed to load'}`
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
				`${names[1]}: ${results[1].reason instanceof Error ? results[1].reason.message : 'Failed to load'}`
			);
		}

		if (results[2].status === 'fulfilled') {
			// Defensive check: ensure data is an array
			reports = Array.isArray(results[2].value.data) ? results[2].value.data : [];
		} else {
			errors.push(
				`${names[2]}: ${results[2].reason instanceof Error ? results[2].reason.message : 'Failed to load'}`
			);
		}

		if (results[3].status === 'fulfilled') {
			dataRetention = results[3].value;
		} else {
			errors.push(
				`${names[3]}: ${results[3].reason instanceof Error ? results[3].reason.message : 'Failed to load'}`
			);
		}

		if (errors.length > 0) {
			error = errors.length === 1 ? errors[0] : `Multiple errors: ${errors.join('; ')}`;
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
			startReviewError = 'Review name is required';
			return;
		}

		if (trimmedName.length > MAX_REVIEW_NAME_LENGTH) {
			startReviewError = `Review name must be ${MAX_REVIEW_NAME_LENGTH} characters or less`;
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
			startReviewError = e instanceof Error ? e.message : 'Failed to start review';
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
			all_users: 'All Users',
			role: 'Role',
			organization: 'Organization',
			inactive_users: 'Inactive Users'
		};
		return validScopes[scope] || 'Unknown';
	}

	/**
	 * Sanitize and format report type for display
	 * Only allows known report types to prevent XSS
	 * Must match API's ReportType definition
	 */
	function formatReportTypeDisplay(type: string): string {
		const validTypes: Record<string, string> = {
			gdpr_dsar: 'GDPR DSAR',
			soc2_audit: 'SOC2 AUDIT',
			access_summary: 'ACCESS SUMMARY',
			user_activity: 'USER ACTIVITY'
		};
		return validTypes[type] || 'UNKNOWN';
	}

	// Global Escape key handler for dialogs
	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && showStartReviewDialog) {
			closeStartReviewDialog();
		}
	}

	// Sanitize API response fields to prevent XSS (defense in depth)
	function sanitizeReview(review: AccessReview): AccessReview {
		return {
			...review,
			name: sanitizeText(review.name)
		};
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
			// Reload data to show updated values
			const freshData = await adminComplianceAPI.getDataRetentionStatus();
			dataRetention = freshData;
		} catch (err) {
			retentionActionError = err instanceof Error ? err.message : 'Failed to execute cleanup';
		} finally {
			cleanupLoading = false;
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<h1 class="page-title">Compliance</h1>
			<p class="modal-description">
				Monitor compliance status across multiple frameworks, manage access reviews, view compliance
				reports, and track data retention policies.
			</p>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Tabs -->
	<div class="security-tabs" role="tablist">
		{#each TABS as tab (tab.id)}
			<button
				onclick={() => {
					error = '';
					activeTab = tab.id;
				}}
				role="tab"
				aria-selected={activeTab === tab.id}
				class="security-tab"
				class:active={activeTab === tab.id}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	{#if loading}
		<div class="loading-state">Loading compliance data...</div>
	{:else if activeTab === 'overview' && complianceStatus}
		<!-- Overview Tab -->
		<div class="compliance-overview">
			<!-- Overall Status -->
			<div class="panel">
				<div class="compliance-overall-header">
					<div>
						<h2 class="section-title">Overall Compliance Status</h2>
						<p class="text-muted">Assessment across all compliance frameworks</p>
					</div>
					<div class={getComplianceStatusClass(complianceStatus.overall_status)}>
						{getComplianceStatusLabel(complianceStatus.overall_status)}
					</div>
				</div>
			</div>

			<!-- Frameworks Grid -->
			<div class="framework-grid">
				{#each complianceStatus.frameworks as framework (framework.framework)}
					<div class="framework-card">
						<div class="framework-card-header">
							<h3 class="framework-name">{getFrameworkDisplayName(framework.framework)}</h3>
							<span class={getComplianceStatusClass(framework.status)}>
								{getComplianceStatusLabel(framework.status)}
							</span>
						</div>
						<div class="framework-progress">
							<div class="framework-progress-info">
								<span>Compliance Progress</span>
								<span>{framework.compliant_checks}/{framework.total_checks} checks</span>
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
								⚠️ {framework.issues.length} issue{framework.issues.length > 1 ? 's' : ''} found
							</div>
						{/if}
						<div class="framework-last-checked">
							Last checked: {formatDate(framework.last_checked)}
						</div>
					</div>
				{/each}
			</div>

			<!-- Quick Stats -->
			<div class="quick-stats-grid">
				<div class="quick-stat-card">
					<div class="quick-stat-label">Data Retention</div>
					<div class={getStatusValueClass(complianceStatus.data_retention?.enabled ?? false)}>
						{complianceStatus.data_retention?.enabled ? 'Enabled' : 'Disabled'}
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">Audit Log</div>
					<div class={getStatusValueClass(complianceStatus.audit_log?.enabled ?? false)}>
						{complianceStatus.audit_log?.retention_days ?? '-'} days
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">MFA Coverage</div>
					<div class="quick-stat-value primary">
						{complianceStatus.mfa_enforcement?.coverage_percent ?? 0}%
					</div>
				</div>
				<div class="quick-stat-card">
					<div class="quick-stat-label">Encryption</div>
					<div
						class="quick-stat-value {complianceStatus.encryption?.at_rest &&
						complianceStatus.encryption?.in_transit
							? 'enabled'
							: 'partial'}"
					>
						{complianceStatus.encryption?.at_rest && complianceStatus.encryption?.in_transit
							? 'Full'
							: 'Partial'}
					</div>
				</div>
			</div>
		</div>
	{:else if activeTab === 'reviews'}
		<!-- Access Reviews Tab -->
		<div>
			<div class="tab-header-actions">
				<button class="btn btn-primary" onclick={openStartReviewDialog}> Start New Review </button>
			</div>

			{#if accessReviews.length === 0}
				<div class="empty-state">
					<p>No access reviews found.</p>
				</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Name</th>
								<th>Scope</th>
								<th>Progress</th>
								<th>Status</th>
								<th>Started</th>
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
											{review.status}
										</span>
									</td>
									<td class="text-muted">{formatDate(review.started_at)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else if activeTab === 'reports'}
		<!-- Reports Tab -->
		<div>
			{#if reports.length === 0}
				<div class="empty-state">
					<p>No compliance reports found.</p>
				</div>
			{:else}
				<div class="table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Type</th>
								<th>Status</th>
								<th>Requested</th>
								<th>Actions</th>
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
											{report.status}
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
												Download
											</a>
										{:else}
											<span class="text-muted">-</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{:else if activeTab === 'retention' && dataRetention}
		<!-- Data Retention Tab -->
		<div class="retention-overview">
			<!-- Status Card -->
			<div class="panel">
				<h2 class="section-title">Data Retention Policy</h2>
				<div class="retention-stats-grid">
					<div class="retention-stat">
						<div class="retention-stat-label">Status</div>
						<div class={getStatusValueClass(dataRetention.enabled)}>
							{dataRetention.enabled ? 'Enabled' : 'Disabled'}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">GDPR Compliant</div>
						<div class={getStatusValueClass(dataRetention.gdpr_compliant)}>
							{dataRetention.gdpr_compliant ? 'Yes' : 'No'}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">Last Cleanup</div>
						<div class="retention-stat-value">
							{dataRetention.last_cleanup ? formatDate(dataRetention.last_cleanup) : '-'}
						</div>
					</div>
					<div class="retention-stat">
						<div class="retention-stat-label">Next Cleanup</div>
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
							<h3 class="section-title">Retention Categories</h3>
							<p class="text-muted">
								Configure how long data is retained before automatic deletion
							</p>
						</div>
						<button class="btn btn-warning" onclick={openCleanupDialog}>
							<span>🗑️</span>
							Run Cleanup
						</button>
					</div>
					<div class="table-container">
						<table class="data-table">
							<thead>
								<tr>
									<th>Category</th>
									<th class="text-center">Retention</th>
									<th class="text-right">Records</th>
									<th>Oldest Record</th>
									<th>Next Cleanup</th>
									<th class="text-center">Actions</th>
								</tr>
							</thead>
							<tbody>
								{#each dataRetention.categories as category (category.category)}
									<tr>
										<td>
											<div class="cell-primary">{getCategoryDisplayName(category.category)}</div>
											<div class="cell-secondary">{getCategoryDescription(category.category)}</div>
										</td>
										<td class="text-center">
											<span class="retention-days-badge">{category.retention_days} days</span>
										</td>
										<td class="text-right">{category.records_count.toLocaleString()}</td>
										<td class="text-muted">
											{category.oldest_record ? formatDate(category.oldest_record) : '-'}
										</td>
										<td class="text-muted">
											{category.next_cleanup ? formatDate(category.next_cleanup) : '-'}
										</td>
										<td class="text-center">
											<button
												class="btn btn-ghost btn-sm"
												onclick={() =>
													openRetentionEditDialog(category.category, category.retention_days)}
											>
												Edit
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>

				<!-- Information Notice -->
				<div class="info-box">
					<span class="info-box-icon">ℹ️</span>
					<div>
						<div class="info-box-title">About Data Retention</div>
						<p class="info-box-text">
							Data retention policies help maintain GDPR compliance by automatically removing old
							data. Tombstones (deletion records) are kept longer to provide proof of deletion for
							regulatory purposes. Contact your administrator to modify retention periods.
						</p>
					</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Start Review Dialog -->
{#if showStartReviewDialog}
	<div
		class="modal-overlay"
		onclick={closeStartReviewDialog}
		onkeydown={(e) => e.key === 'Escape' && closeStartReviewDialog()}
		tabindex="-1"
		role="presentation"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="start-review-dialog-title"
		>
			<div class="modal-header">
				<h2 id="start-review-dialog-title" class="modal-title">Start Access Review</h2>
			</div>

			<div class="modal-body">
				{#if startReviewError}
					<div class="alert alert-error">{startReviewError}</div>
				{/if}

				<div class="form-group">
					<label for="review-name" class="form-label">Review Name</label>
					<input
						type="text"
						id="review-name"
						class="form-input"
						bind:value={newReviewName}
						placeholder="e.g., Q1 2026 Access Review"
					/>
				</div>

				<div class="form-group">
					<label for="review-scope" class="form-label">Scope</label>
					<select id="review-scope" class="form-select" bind:value={newReviewScope}>
						<option value="all_users">All Users</option>
						<option value="role">By Role</option>
						<option value="organization">By Organization</option>
						<option value="inactive_users">Inactive Users</option>
					</select>
				</div>

				<div class="form-group">
					<label for="review-due-date" class="form-label">Due Date (optional)</label>
					<input
						type="date"
						id="review-due-date"
						class="form-input"
						bind:value={newReviewDueDate}
					/>
				</div>
			</div>

			<div class="modal-footer">
				<button
					class="btn btn-secondary"
					onclick={closeStartReviewDialog}
					disabled={startingReview}
				>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={handleStartReview} disabled={startingReview}>
					{startingReview ? 'Starting...' : 'Start Review'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Retention Policy Edit Dialog -->
<RetentionPolicyEditDialog
	open={showRetentionEditDialog}
	category={editingCategory}
	currentRetentionDays={editingRetentionDays}
	onClose={closeRetentionEditDialog}
	onSave={handleRetentionSave}
/>

<!-- Cleanup Confirmation Dialog -->
{#if showCleanupDialog}
	<div
		class="modal-overlay"
		onclick={closeCleanupDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCleanupDialog()}
		tabindex="-1"
		role="presentation"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="dialog"
			aria-modal="true"
			aria-labelledby="cleanup-dialog-title"
		>
			{#if cleanupResult}
				<!-- Success State -->
				<div class="cleanup-success">
					<div class="cleanup-success-icon">✅</div>
					<h2 id="cleanup-dialog-title" class="modal-title">Cleanup Completed</h2>
					<p class="text-muted">
						Successfully deleted <strong>{cleanupResult.deleted.toLocaleString()}</strong> records.
					</p>
					<p class="cleanup-run-id">Run ID: {cleanupResult.runId}</p>
					<button class="btn btn-primary" onclick={closeCleanupDialog}>Close</button>
				</div>
			{:else}
				<!-- Confirmation State -->
				<div class="modal-header">
					<h2 id="cleanup-dialog-title" class="modal-title">Run Data Cleanup</h2>
				</div>

				<div class="modal-body">
					{#if retentionActionError}
						<div class="alert alert-error">{retentionActionError}</div>
					{/if}

					<div class="warning-box">
						<span class="warning-box-icon">⚠️</span>
						<div>
							<div class="warning-box-title">Warning: This action cannot be undone</div>
							<p class="warning-box-text">
								This will permanently delete all data that exceeds the configured retention periods
								across all categories. Records older than their category's retention period will be
								removed.
							</p>
						</div>
					</div>

					<p class="text-muted cleanup-confirm-text">
						Are you sure you want to run the data cleanup now? This process will delete expired
						records based on each category's retention policy.
					</p>
				</div>

				<div class="modal-footer">
					<button class="btn btn-secondary" onclick={closeCleanupDialog} disabled={cleanupLoading}>
						Cancel
					</button>
					<button class="btn btn-danger" onclick={executeCleanup} disabled={cleanupLoading}>
						{cleanupLoading ? 'Deleting...' : 'Delete Expired Data'}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
