<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminJobsAPI,
		getJobStatusColor,
		getJobTypeDisplayName,
		getReportTypeDisplayName,
		formatJobDuration,
		type Job,
		type JobStatus,
		type JobType,
		type ReportType
	} from '$lib/api/admin-jobs';
	import {
		formatDate,
		isValidDownloadUrl,
		DEFAULT_PAGE_SIZE,
		JOB_POLLING_INTERVAL,
		sanitizeText
	} from '$lib/utils';

	// State
	let loading = $state(true);
	let error = $state('');
	let jobs = $state<Job[]>([]);

	// Filters
	let statusFilter = $state<JobStatus | ''>('');
	let typeFilter = $state<JobType | ''>('');

	// Create Report Dialog
	let showCreateReportDialog = $state(false);
	let creatingReport = $state(false);
	let createReportError = $state('');
	let reportType = $state<ReportType>('user_activity');
	let reportFromDate = $state('');
	let reportToDate = $state('');

	// Job Detail Dialog
	let showJobDetailDialog = $state(false);
	let selectedJob = $state<Job | null>(null);
	let loadingJobDetail = $state(false);

	// Polling for running jobs
	let pollingInterval: ReturnType<typeof setInterval> | null = null;
	let isPolling = false; // Prevent duplicate API calls during polling

	// Sanitize API response fields to prevent XSS (defense in depth)
	function sanitizeJob(job: Job): Job {
		return {
			...job,
			created_by: sanitizeText(job.created_by),
			progress: job.progress
				? {
						...job.progress,
						current_item: job.progress.current_item
							? sanitizeText(job.progress.current_item)
							: undefined
					}
				: undefined,
			result: job.result
				? {
						...job.result,
						failures: job.result.failures.map((f) => ({
							...f,
							error: sanitizeText(f.error || '')
						}))
					}
				: undefined
		};
	}

	async function loadJobs() {
		try {
			const params: { status?: JobStatus; type?: JobType } = {};
			if (statusFilter) params.status = statusFilter;
			if (typeFilter) params.type = typeFilter;

			const response = await adminJobsAPI.list({ ...params, limit: DEFAULT_PAGE_SIZE });
			// Defensive check: ensure response.data is an array
			// Apply sanitization to prevent XSS
			jobs = Array.isArray(response.data) ? response.data.map(sanitizeJob) : [];
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load jobs';
		}
	}

	async function loadData() {
		loading = true;
		error = '';
		await loadJobs();
		loading = false;
	}

	onMount(() => {
		loadData();

		// Poll for updates if there are running jobs
		pollingInterval = setInterval(async () => {
			const hasRunningJobs = jobs.some((j) => j.status === 'pending' || j.status === 'running');
			// Only poll if there are running jobs and not already polling
			if (hasRunningJobs && !isPolling) {
				isPolling = true;
				try {
					await loadJobs();
				} catch (e) {
					// Log polling errors in development for debugging, but don't show to user
					if (import.meta.env.DEV) {
						console.warn('[Jobs Polling] Failed to refresh:', e instanceof Error ? e.message : e);
					}
				} finally {
					isPolling = false;
				}
			}
		}, JOB_POLLING_INTERVAL);

		return () => {
			if (pollingInterval) {
				clearInterval(pollingInterval);
				pollingInterval = null;
			}
		};
	});

	function openCreateReportDialog() {
		reportType = 'user_activity';
		reportFromDate = '';
		reportToDate = '';
		createReportError = '';
		showCreateReportDialog = true;
	}

	function closeCreateReportDialog() {
		showCreateReportDialog = false;
	}

	const MAX_DATE_RANGE_DAYS = 730; // 2 years

	async function handleCreateReport() {
		createReportError = '';

		// Validate date range
		if (reportFromDate || reportToDate) {
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

			if (reportFromDate && reportToDate) {
				const from = new Date(reportFromDate);
				const to = new Date(reportToDate);

				if (from > to) {
					createReportError = 'From date must be before To date';
					return;
				}

				// Check for future dates
				if (to > today) {
					createReportError = 'To date cannot be in the future';
					return;
				}

				// Check date range limit
				const daysDiff = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
				if (daysDiff > MAX_DATE_RANGE_DAYS) {
					createReportError = `Date range cannot exceed ${MAX_DATE_RANGE_DAYS} days (${Math.floor(MAX_DATE_RANGE_DAYS / 365)} years)`;
					return;
				}
			}

			// Single date validation
			if (reportToDate) {
				const to = new Date(reportToDate);
				if (to > today) {
					createReportError = 'To date cannot be in the future';
					return;
				}
			}
		}

		creatingReport = true;

		try {
			const params: {
				type: ReportType;
				parameters?: { from?: string; to?: string };
			} = { type: reportType };

			if (reportFromDate || reportToDate) {
				params.parameters = {};
				if (reportFromDate) params.parameters.from = new Date(reportFromDate).toISOString();
				if (reportToDate) params.parameters.to = new Date(reportToDate).toISOString();
			}

			const job = await adminJobsAPI.createReport(params);
			jobs = [job, ...jobs];
			closeCreateReportDialog();
		} catch (e) {
			createReportError = e instanceof Error ? e.message : 'Failed to create report job';
		} finally {
			creatingReport = false;
		}
	}

	async function viewJobDetail(job: Job) {
		selectedJob = job;
		showJobDetailDialog = true;
		loadingJobDetail = true;

		try {
			const updatedJob = await adminJobsAPI.get(job.id);
			selectedJob = updatedJob;
		} catch {
			// Keep the original job data if refresh fails
		} finally {
			loadingJobDetail = false;
		}
	}

	function closeJobDetailDialog() {
		showJobDetailDialog = false;
		selectedJob = null;
		loadingJobDetail = false; // Clear loading state
	}

	function getProgressPercent(job: Job): number {
		if (job.progress) {
			const percentage = job.progress.percentage;
			// Defensive check: ensure percentage is a valid number
			if (typeof percentage === 'number' && !isNaN(percentage) && isFinite(percentage)) {
				// Clamp to 0-100 to prevent UI overflow
				return Math.min(100, Math.max(0, percentage));
			}
		}
		if (job.status === 'completed') return 100;
		if (job.status === 'pending') return 0;
		return 50; // Running without progress info
	}

	function getStatusBadgeClass(status: JobStatus): string {
		switch (status) {
			case 'completed':
				return 'badge badge-success';
			case 'running':
				return 'badge badge-info';
			case 'pending':
				return 'badge badge-warning';
			case 'failed':
				return 'badge badge-danger';
			case 'cancelled':
				return 'badge badge-neutral';
			default:
				return 'badge badge-neutral';
		}
	}

	// Track if initial data load has completed
	let initialLoadComplete = false;
	// Track previous filter values to detect actual changes
	let prevStatusFilter = '';
	let prevTypeFilter = '';

	// Reactive filter effect - reload jobs when filters change
	$effect(() => {
		const currentStatus = statusFilter;
		const currentType = typeFilter;
		const isLoading = loading;

		// Skip effect during initial mount (onMount handles first load)
		if (!initialLoadComplete) {
			if (!isLoading) {
				initialLoadComplete = true;
				prevStatusFilter = currentStatus;
				prevTypeFilter = currentType;
			}
			return;
		}

		// Only reload if filters actually changed
		const filtersChanged = currentStatus !== prevStatusFilter || currentType !== prevTypeFilter;

		if (!isLoading && filtersChanged) {
			error = ''; // Clear errors when filters change
			prevStatusFilter = currentStatus;
			prevTypeFilter = currentType;
			void loadJobs();
		}
	});

	// Global Escape key handler for dialogs
	// Priority: JobDetail > CreateReport (JobDetail appears on top if both were somehow open)
	function handleGlobalKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (showJobDetailDialog) {
				closeJobDetailDialog();
			} else if (showCreateReportDialog) {
				closeCreateReportDialog();
			}
		}
	}
</script>

<svelte:head>
	<title>Jobs - Admin Dashboard - Authrim</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Jobs</h1>
			<p class="page-description">
				Monitor background jobs including user imports, bulk updates, and report generation. Jobs
				automatically refresh while running.
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={openCreateReportDialog}>
				<i class="i-ph-file-text"></i>
				Generate Report
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group">
				<label for="status-filter" class="form-label">Status</label>
				<select id="status-filter" class="form-select" bind:value={statusFilter}>
					<option value="">All Status</option>
					<option value="pending">Pending</option>
					<option value="running">Running</option>
					<option value="completed">Completed</option>
					<option value="failed">Failed</option>
					<option value="cancelled">Cancelled</option>
				</select>
			</div>
			<div class="form-group">
				<label for="type-filter" class="form-label">Type</label>
				<select id="type-filter" class="form-select" bind:value={typeFilter}>
					<option value="">All Types</option>
					<option value="users_import">User Import</option>
					<option value="users_bulk_update">Bulk Update</option>
					<option value="report_generation">Report Generation</option>
					<option value="org_bulk_members">Org Bulk Members</option>
				</select>
			</div>
			<div class="form-group form-group-action">
				<button class="btn btn-secondary" onclick={loadData} disabled={loading}>
					<i class="i-ph-arrows-clockwise"></i>
					Refresh
				</button>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading jobs...</p>
		</div>
	{:else if jobs.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No jobs found.</p>
				{#if statusFilter || typeFilter}
					<p class="empty-state-hint">
						Current filters:
						{#if statusFilter}<span class="badge badge-neutral">{statusFilter}</span>{/if}
						{#if typeFilter}<span class="badge badge-neutral"
								>{getJobTypeDisplayName(typeFilter)}</span
							>{/if}
					</p>
					<button
						class="btn btn-secondary"
						onclick={() => {
							statusFilter = '';
							typeFilter = '';
						}}
					>
						Clear filters
					</button>
				{:else}
					<p class="empty-state-hint">Generate a report or import users to create a job.</p>
				{/if}
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Type</th>
						<th>Status</th>
						<th>Progress</th>
						<th>Duration</th>
						<th>Created</th>
						<th class="text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each jobs as job (job.id)}
						<tr>
							<td>
								<div class="cell-primary">{getJobTypeDisplayName(job.type)}</div>
								<div class="cell-secondary mono">{job.id.substring(0, 8)}...</div>
							</td>
							<td>
								<span class={getStatusBadgeClass(job.status)}>
									{#if job.status === 'running'}
										<span class="pulse-dot"></span>
									{/if}
									{job.status}
								</span>
							</td>
							<td>
								<div class="progress-cell">
									<div class="progress-bar">
										<div
											class="progress-fill"
											style="width: {getProgressPercent(
												job
											)}%; background-color: {getJobStatusColor(job.status)};"
										></div>
									</div>
									<span class="progress-text">{getProgressPercent(job)}%</span>
								</div>
							</td>
							<td class="muted">{formatJobDuration(job.started_at, job.completed_at)}</td>
							<td class="muted nowrap">{formatDate(job.created_at)}</td>
							<td class="text-right">
								<button class="btn btn-secondary btn-sm" onclick={() => viewJobDetail(job)}>
									View Details
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Create Report Dialog -->
{#if showCreateReportDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateReportDialog}
		role="dialog"
		aria-modal="true"
		aria-labelledby="create-report-dialog-title"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 id="create-report-dialog-title" class="modal-title">Generate Report</h2>
			</div>

			<div class="modal-body">
				{#if createReportError}
					<div class="alert alert-error">{createReportError}</div>
				{/if}

				<div class="form-group">
					<label for="report-type" class="form-label">Report Type</label>
					<select id="report-type" class="form-select" bind:value={reportType}>
						<option value="user_activity">{getReportTypeDisplayName('user_activity')}</option>
						<option value="access_summary">{getReportTypeDisplayName('access_summary')}</option>
						<option value="compliance_audit">{getReportTypeDisplayName('compliance_audit')}</option>
						<option value="security_events">{getReportTypeDisplayName('security_events')}</option>
					</select>
				</div>

				<div class="filter-row">
					<div class="form-group">
						<label for="report-from" class="form-label">From Date (optional)</label>
						<input id="report-from" type="date" class="form-input" bind:value={reportFromDate} />
					</div>
					<div class="form-group">
						<label for="report-to" class="form-label">To Date (optional)</label>
						<input id="report-to" type="date" class="form-input" bind:value={reportToDate} />
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button
					class="btn btn-secondary"
					onclick={closeCreateReportDialog}
					disabled={creatingReport}>Cancel</button
				>
				<button class="btn btn-primary" onclick={handleCreateReport} disabled={creatingReport}>
					{creatingReport ? 'Creating...' : 'Generate Report'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Job Detail Dialog -->
{#if showJobDetailDialog && selectedJob}
	<div
		class="modal-overlay"
		onclick={closeJobDetailDialog}
		role="dialog"
		aria-modal="true"
		aria-labelledby="job-detail-dialog-title"
	>
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<div>
					<h2 id="job-detail-dialog-title" class="modal-title">
						{getJobTypeDisplayName(selectedJob.type)}
					</h2>
					<div class="cell-secondary mono">{selectedJob.id}</div>
				</div>
				<button class="modal-close" onclick={closeJobDetailDialog} aria-label="Close dialog">
					<i class="i-ph-x"></i>
				</button>
			</div>

			<div class="modal-body">
				{#if loadingJobDetail}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>Loading...</p>
					</div>
				{:else}
					<div class="info-grid">
						<div class="info-card">
							<span class="info-label">Status</span>
							<span class={getStatusBadgeClass(selectedJob.status)}>{selectedJob.status}</span>
						</div>
						<div class="info-card">
							<span class="info-label">Duration</span>
							<span class="info-value"
								>{formatJobDuration(selectedJob.started_at, selectedJob.completed_at)}</span
							>
						</div>
						<div class="info-card">
							<span class="info-label">Created</span>
							<span class="info-value">{formatDate(selectedJob.created_at)}</span>
						</div>
						<div class="info-card">
							<span class="info-label">Created By</span>
							<span class="info-value">{selectedJob.created_by}</span>
						</div>
					</div>

					{#if selectedJob.progress}
						<div class="detail-section">
							<h3 class="detail-section-title">Progress</h3>
							<div class="progress-detail">
								<div class="progress-bar-lg">
									<div
										class="progress-fill"
										style="width: {getProgressPercent(
											selectedJob
										)}%; background-color: {getJobStatusColor(selectedJob.status)};"
									></div>
								</div>
								<span class="progress-text">
									{selectedJob.progress.processed}/{selectedJob.progress.total}
								</span>
							</div>
							{#if selectedJob.progress.current_item}
								<p class="muted">Processing: {selectedJob.progress.current_item}</p>
							{/if}
						</div>
					{/if}

					{#if selectedJob.result}
						<div class="detail-section">
							<h3 class="detail-section-title">Result Summary</h3>
							<div class="result-grid">
								<div class="result-card success">
									<span class="result-value">{selectedJob.result.summary.success_count}</span>
									<span class="result-label">Succeeded</span>
								</div>
								<div class="result-card danger">
									<span class="result-value">{selectedJob.result.summary.failure_count}</span>
									<span class="result-label">Failed</span>
								</div>
								<div class="result-card neutral">
									<span class="result-value">{selectedJob.result.summary.skipped_count}</span>
									<span class="result-label">Skipped</span>
								</div>
							</div>

							{#if selectedJob.result.failures.length > 0}
								<div class="failures-section">
									<h4 class="failures-title">Failures ({selectedJob.result.failures.length})</h4>
									<div class="failures-list">
										{#each selectedJob.result.failures.slice(0, 10) as failure, i (i)}
											<div class="failure-item">
												{#if failure.line}Line {failure.line}:
												{/if}{failure.error || 'Unknown error'}
											</div>
										{/each}
										{#if selectedJob.result.failures.length > 10}
											<div class="muted">
												... and {selectedJob.result.failures.length - 10} more
											</div>
										{/if}
									</div>
								</div>
							{/if}

							{#if selectedJob.result.download_url && isValidDownloadUrl(selectedJob.result.download_url)}
								<a
									href={selectedJob.result.download_url}
									target="_blank"
									rel="noopener noreferrer"
									class="btn btn-primary"
								>
									<i class="i-ph-download"></i>
									Download Result
								</a>
							{/if}
						</div>
					{/if}

					{#if selectedJob.parameters && Object.keys(selectedJob.parameters).length > 0}
						<div class="detail-section">
							<h3 class="detail-section-title">Parameters</h3>
							<pre class="code-block">{JSON.stringify(selectedJob.parameters, null, 2)}</pre>
						</div>
					{/if}
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeJobDetailDialog}>Close</button>
			</div>
		</div>
	</div>
{/if}
