<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminComplianceAPI,
		getComplianceStatusColor,
		getComplianceStatusLabel,
		getFrameworkDisplayName,
		type ComplianceStatus,
		type AccessReview,
		type ComplianceReport,
		type DataRetentionStatus,
		type AccessReviewScope
	} from '$lib/api/admin-compliance';
	import { getCategoryDisplayName, getCategoryDescription } from '$lib/api/admin-data-retention';
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

	// Start Review Dialog
	let showStartReviewDialog = $state(false);
	let startingReview = $state(false);
	let startReviewError = $state('');
	let newReviewName = $state('');
	let newReviewScope = $state<AccessReviewScope>('all_users');
	let newReviewDueDate = $state('');

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
	 * Get color for review status
	 */
	function getReviewStatusColor(status: string): string {
		const colors: Record<string, string> = {
			pending: '#6b7280',
			in_progress: '#3b82f6',
			completed: '#22c55e',
			cancelled: '#9ca3af'
		};
		return colors[status] || '#6b7280';
	}

	/**
	 * Get color for report status
	 */
	function getReportStatusColor(status: string): string {
		const colors: Record<string, string> = {
			pending: '#6b7280',
			generating: '#3b82f6',
			completed: '#22c55e',
			failed: '#ef4444'
		};
		return colors[status] || '#6b7280';
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
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div>
	<div
		style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;"
	>
		<h1 style="font-size: 24px; font-weight: bold; margin: 0; color: #1f2937;">Compliance</h1>
	</div>

	<p style="color: #6b7280; margin-bottom: 24px;">
		Monitor compliance status across multiple frameworks, manage access reviews, view compliance
		reports, and track data retention policies.
	</p>

	{#if error}
		<div
			style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
		>
			{error}
		</div>
	{/if}

	<!-- Tabs -->
	<div style="display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid #e5e7eb;">
		{#each [{ id: 'overview', label: 'Overview' }, { id: 'reviews', label: 'Access Reviews' }, { id: 'reports', label: 'Reports' }, { id: 'retention', label: 'Data Retention' }] as tab (tab.id)}
			<button
				onclick={() => {
					error = ''; // Clear errors when switching tabs
					activeTab = tab.id as typeof activeTab;
				}}
				style="
					padding: 12px 24px;
					background: none;
					border: none;
					border-bottom: 2px solid {activeTab === tab.id ? '#3b82f6' : 'transparent'};
					color: {activeTab === tab.id ? '#3b82f6' : '#6b7280'};
					font-size: 14px;
					font-weight: 500;
					cursor: pointer;
				"
			>
				{tab.label}
			</button>
		{/each}
	</div>

	{#if loading}
		<div style="text-align: center; padding: 48px; color: #6b7280;">Loading compliance data...</div>
	{:else if activeTab === 'overview' && complianceStatus}
		<!-- Overview Tab -->
		<div style="display: grid; gap: 24px;">
			<!-- Overall Status -->
			<div style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 24px;">
				<div style="display: flex; justify-content: space-between; align-items: center;">
					<div>
						<h2 style="font-size: 18px; font-weight: 600; margin: 0 0 8px 0; color: #1f2937;">
							Overall Compliance Status
						</h2>
						<p style="color: #6b7280; margin: 0;">Assessment across all compliance frameworks</p>
					</div>
					<div
						style="
							padding: 12px 24px;
							border-radius: 8px;
							background-color: {getComplianceStatusColor(complianceStatus.overall_status)}15;
							color: {getComplianceStatusColor(complianceStatus.overall_status)};
							font-weight: 600;
							font-size: 16px;
						"
					>
						{getComplianceStatusLabel(complianceStatus.overall_status)}
					</div>
				</div>
			</div>

			<!-- Frameworks Grid -->
			<div
				style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px;"
			>
				{#each complianceStatus.frameworks as framework (framework.framework)}
					<div
						style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 20px;"
					>
						<div
							style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;"
						>
							<h3 style="font-size: 16px; font-weight: 600; margin: 0; color: #1f2937;">
								{getFrameworkDisplayName(framework.framework)}
							</h3>
							<span
								style="
									padding: 4px 10px;
									border-radius: 9999px;
									font-size: 12px;
									font-weight: 500;
									background-color: {getComplianceStatusColor(framework.status)}15;
									color: {getComplianceStatusColor(framework.status)};
								"
							>
								{getComplianceStatusLabel(framework.status)}
							</span>
						</div>
						<div style="margin-bottom: 12px;">
							<div
								style="display: flex; justify-content: space-between; font-size: 13px; color: #6b7280; margin-bottom: 4px;"
							>
								<span>Compliance Progress</span>
								<span>{framework.compliant_checks}/{framework.total_checks} checks</span>
							</div>
							<div
								style="height: 6px; background-color: #e5e7eb; border-radius: 3px; overflow: hidden;"
							>
								<div
									style="
										height: 100%;
										width: {framework.total_checks > 0
										? (framework.compliant_checks / framework.total_checks) * 100
										: 0}%;
										background-color: {getComplianceStatusColor(framework.status)};
										border-radius: 3px;
									"
								></div>
							</div>
						</div>
						{#if framework.issues.length > 0}
							<div style="font-size: 12px; color: #ef4444;">
								⚠️ {framework.issues.length} issue{framework.issues.length > 1 ? 's' : ''} found
							</div>
						{/if}
						<div style="font-size: 11px; color: #9ca3af; margin-top: 8px;">
							Last checked: {formatDate(framework.last_checked)}
						</div>
					</div>
				{/each}
			</div>

			<!-- Quick Stats -->
			<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 20px; text-align: center;"
				>
					<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Data Retention</div>
					<div
						style="font-size: 20px; font-weight: 600; color: {complianceStatus.data_retention
							?.enabled
							? '#22c55e'
							: '#ef4444'};"
					>
						{complianceStatus.data_retention?.enabled ? 'Enabled' : 'Disabled'}
					</div>
				</div>
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 20px; text-align: center;"
				>
					<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Audit Log</div>
					<div
						style="font-size: 20px; font-weight: 600; color: {complianceStatus.audit_log?.enabled
							? '#22c55e'
							: '#ef4444'};"
					>
						{complianceStatus.audit_log?.retention_days ?? '-'} days
					</div>
				</div>
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 20px; text-align: center;"
				>
					<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">MFA Coverage</div>
					<div style="font-size: 20px; font-weight: 600; color: #3b82f6;">
						{complianceStatus.mfa_enforcement?.coverage_percent ?? 0}%
					</div>
				</div>
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 20px; text-align: center;"
				>
					<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Encryption</div>
					<div
						style="font-size: 20px; font-weight: 600; color: {complianceStatus.encryption
							?.at_rest && complianceStatus.encryption?.in_transit
							? '#22c55e'
							: '#f59e0b'};"
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
			<div style="display: flex; justify-content: flex-end; margin-bottom: 16px;">
				<button
					onclick={openStartReviewDialog}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-weight: 500;
						font-size: 14px;
					"
				>
					Start New Review
				</button>
			</div>

			{#if accessReviews.length === 0}
				<div
					style="text-align: center; padding: 48px; background: white; border-radius: 8px; border: 1px solid #e5e7eb;"
				>
					<p style="color: #6b7280; margin: 0;">No access reviews found.</p>
				</div>
			{:else}
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden;"
				>
					<table style="width: 100%; border-collapse: collapse;">
						<thead>
							<tr style="background-color: #f9fafb;">
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Name</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Scope</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Progress</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Status</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Started</th
								>
							</tr>
						</thead>
						<tbody>
							{#each accessReviews as review (review.id)}
								<tr style="border-top: 1px solid #e5e7eb;">
									<td style="padding: 12px 16px;">
										<div style="font-weight: 500; color: #1f2937;">{review.name}</div>
									</td>
									<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
										{formatScopeDisplay(review.scope)}
									</td>
									<td style="padding: 12px 16px;">
										<div style="display: flex; align-items: center; gap: 8px;">
											<div
												style="flex: 1; height: 6px; background-color: #e5e7eb; border-radius: 3px; overflow: hidden; max-width: 100px;"
											>
												<div
													style="
														height: 100%;
														width: {review.total_users > 0 ? (review.reviewed_users / review.total_users) * 100 : 0}%;
														background-color: #3b82f6;
													"
												></div>
											</div>
											<span style="font-size: 12px; color: #6b7280;">
												{review.reviewed_users}/{review.total_users}
											</span>
										</div>
									</td>
									<td style="padding: 12px 16px;">
										<span
											style="
												padding: 4px 10px;
												border-radius: 9999px;
												font-size: 12px;
												font-weight: 500;
												background-color: {getReviewStatusColor(review.status)}15;
												color: {getReviewStatusColor(review.status)};
											"
										>
											{review.status}
										</span>
									</td>
									<td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">
										{formatDate(review.started_at)}
									</td>
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
				<div
					style="text-align: center; padding: 48px; background: white; border-radius: 8px; border: 1px solid #e5e7eb;"
				>
					<p style="color: #6b7280; margin: 0;">No compliance reports found.</p>
				</div>
			{:else}
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden;"
				>
					<table style="width: 100%; border-collapse: collapse;">
						<thead>
							<tr style="background-color: #f9fafb;">
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Type</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Status</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Requested</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Actions</th
								>
							</tr>
						</thead>
						<tbody>
							{#each reports as report (report.id)}
								<tr style="border-top: 1px solid #e5e7eb;">
									<td style="padding: 12px 16px;">
										<div style="font-weight: 500; color: #1f2937;">
											{formatReportTypeDisplay(report.type)}
										</div>
									</td>
									<td style="padding: 12px 16px;">
										<span
											style="
												padding: 4px 10px;
												border-radius: 9999px;
												font-size: 12px;
												font-weight: 500;
												background-color: {getReportStatusColor(report.status)}15;
												color: {getReportStatusColor(report.status)};
											"
										>
											{report.status}
										</span>
									</td>
									<td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">
										{formatDate(report.requested_at)}
									</td>
									<td style="padding: 12px 16px;">
										{#if report.status === 'completed' && report.download_url && isValidDownloadUrl(report.download_url)}
											<a
												href={report.download_url}
												target="_blank"
												rel="noopener noreferrer"
												style="color: #3b82f6; font-size: 14px; text-decoration: none;"
											>
												Download
											</a>
										{:else}
											<span style="color: #9ca3af; font-size: 14px;">-</span>
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
		<div style="display: grid; gap: 24px;">
			<!-- Status Card -->
			<div style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; padding: 24px;">
				<h2 style="font-size: 18px; font-weight: 600; margin: 0 0 16px 0; color: #1f2937;">
					Data Retention Policy
				</h2>
				<div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
					<div>
						<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Status</div>
						<div
							style="font-size: 16px; font-weight: 600; color: {dataRetention.enabled
								? '#22c55e'
								: '#ef4444'};"
						>
							{dataRetention.enabled ? 'Enabled' : 'Disabled'}
						</div>
					</div>
					<div>
						<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">GDPR Compliant</div>
						<div
							style="font-size: 16px; font-weight: 600; color: {dataRetention.gdpr_compliant
								? '#22c55e'
								: '#ef4444'};"
						>
							{dataRetention.gdpr_compliant ? 'Yes' : 'No'}
						</div>
					</div>
					<div>
						<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Last Cleanup</div>
						<div style="font-size: 16px; font-weight: 600; color: #374151;">
							{dataRetention.last_cleanup ? formatDate(dataRetention.last_cleanup) : '-'}
						</div>
					</div>
					<div>
						<div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Next Cleanup</div>
						<div style="font-size: 16px; font-weight: 600; color: #374151;">
							{dataRetention.next_scheduled_cleanup
								? formatDate(dataRetention.next_scheduled_cleanup)
								: '-'}
						</div>
					</div>
				</div>
			</div>

			<!-- Categories -->
			{#if dataRetention.categories.length > 0}
				<div
					style="background: white; border-radius: 8px; border: 1px solid #e5e7eb; overflow: hidden;"
				>
					<div
						style="padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;"
					>
						<div>
							<h3 style="font-size: 16px; font-weight: 600; margin: 0 0 4px 0; color: #1f2937;">
								Retention Categories
							</h3>
							<p style="font-size: 13px; color: #6b7280; margin: 0;">
								Configure how long data is retained before automatic deletion
							</p>
						</div>
					</div>
					<table style="width: 100%; border-collapse: collapse;">
						<thead>
							<tr style="background-color: #f9fafb;">
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Category</th
								>
								<th
									style="padding: 12px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Retention</th
								>
								<th
									style="padding: 12px 16px; text-align: right; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Records</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Oldest Record</th
								>
								<th
									style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase;"
									>Next Cleanup</th
								>
							</tr>
						</thead>
						<tbody>
							{#each dataRetention.categories as category (category.category)}
								<tr style="border-top: 1px solid #e5e7eb;">
									<td style="padding: 12px 16px;">
										<div style="font-weight: 500; color: #1f2937;">
											{getCategoryDisplayName(category.category)}
										</div>
										<div style="font-size: 12px; color: #6b7280; margin-top: 2px;">
											{getCategoryDescription(category.category)}
										</div>
									</td>
									<td style="padding: 12px 16px; text-align: center;">
										<span
											style="
												display: inline-block;
												padding: 4px 12px;
												border-radius: 9999px;
												font-size: 13px;
												font-weight: 500;
												background-color: #f3f4f6;
												color: #374151;
											"
										>
											{category.retention_days} days
										</span>
									</td>
									<td style="padding: 12px 16px; text-align: right; font-size: 14px; color: #374151;">
										{category.records_count.toLocaleString()}
									</td>
									<td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">
										{category.oldest_record ? formatDate(category.oldest_record) : '-'}
									</td>
									<td style="padding: 12px 16px; font-size: 13px; color: #6b7280;">
										{category.next_cleanup ? formatDate(category.next_cleanup) : '-'}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<!-- Information Notice -->
				<div
					style="background-color: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 16px; display: flex; gap: 12px; align-items: flex-start;"
				>
					<span style="font-size: 20px;">ℹ️</span>
					<div>
						<div style="font-weight: 500; color: #1e40af; margin-bottom: 4px;">
							About Data Retention
						</div>
						<p style="font-size: 13px; color: #1e40af; margin: 0;">
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
		style="position: fixed; inset: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 50;"
		onclick={closeStartReviewDialog}
		role="dialog"
		aria-modal="true"
		aria-labelledby="start-review-dialog-title"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2
				id="start-review-dialog-title"
				style="font-size: 18px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;"
			>
				Start Access Review
			</h2>

			{#if startReviewError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{startReviewError}
				</div>
			{/if}

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Review Name
				</label>
				<input
					type="text"
					bind:value={newReviewName}
					placeholder="e.g., Q1 2026 Access Review"
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Scope
				</label>
				<select
					bind:value={newReviewScope}
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				>
					<option value="all_users">All Users</option>
					<option value="role">By Role</option>
					<option value="organization">By Organization</option>
					<option value="inactive_users">Inactive Users</option>
				</select>
			</div>

			<div style="margin-bottom: 24px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Due Date (optional)
				</label>
				<input
					type="date"
					bind:value={newReviewDueDate}
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeStartReviewDialog}
					disabled={startingReview}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={handleStartReview}
					disabled={startingReview}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {startingReview ? 0.7 : 1};
					"
				>
					{startingReview ? 'Starting...' : 'Start Review'}
				</button>
			</div>
		</div>
	</div>
{/if}
