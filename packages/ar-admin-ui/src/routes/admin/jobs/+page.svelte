	<script lang="ts">
		import { onMount } from 'svelte';
		import { SvelteDate } from 'svelte/reactivity';
	import {
		adminJobsAPI,
		getJobStatusColor,
		getJobStatusDisplayName,
		getJobTypeDisplayName,
		getReportTypeDisplayName,
		formatJobDuration,
		type Job,
		type JobStatus,
		type JobType,
		type JobTypeDefinition,
		type ReportType
	} from '$lib/api/admin-jobs';
	import {
		adminStorageDestinationsAPI,
		type StorageDestination
	} from '$lib/api/admin-storage-destinations';
	import {
		formatDate,
		isValidDownloadUrl,
		DEFAULT_PAGE_SIZE,
		JOB_POLLING_INTERVAL,
		sanitizeText
	} from '$lib/utils';
	import { Modal } from '$lib/components';

	// State
	let loading = $state(true);
	let error = $state('');
	let jobs = $state<Job[]>([]);
	let jobTypes = $state<JobTypeDefinition[]>([]);
	let jobTypeError = $state('');

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
	let reportFormat = $state<'json' | 'csv'>('json');
	let reportResultDelivery = $state<'auto' | 'inline' | 'artifact'>('auto');
	let reportStorageDestinationId = $state('');
	let storageDestinations = $state<StorageDestination[]>([]);

	// Create Import Dialog
	let showCreateImportDialog = $state(false);
	let creatingImport = $state(false);
	let createImportError = $state('');
	let importFile = $state<File | null>(null);
	let importSkipHeader = $state(true);
	let importOnDuplicate = $state<'skip' | 'update' | 'error'>('skip');
	let importValidateOnly = $state(false);

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
						logs: job.result.logs.map((entry) => ({
							...entry,
							message: sanitizeText(entry.message || '')
						})),
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

	async function loadJobTypes() {
		try {
			const response = await adminJobsAPI.listTypes();
			jobTypes = response.job_types.filter((jobType) => jobType.creatable_from_admin_api);
			jobTypeError = '';
		} catch (e) {
			jobTypeError = e instanceof Error ? e.message : 'Failed to load job types';
			jobTypes = [];
		}
	}

	async function loadData() {
		loading = true;
		error = '';
		await Promise.all([loadJobs(), loadJobTypes(), loadStorageDestinations()]);
		loading = false;
	}

	async function loadStorageDestinations() {
		try {
			const response = await adminStorageDestinationsAPI.listUsable();
			storageDestinations = response.items;
		} catch {
			storageDestinations = [];
		}
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
					if (
						selectedJob &&
						showJobDetailDialog &&
						(selectedJob.status === 'pending' || selectedJob.status === 'running')
					) {
						await refreshSelectedJob(selectedJob.id);
					}
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
		const now = new SvelteDate();
		const to = new SvelteDate(now.getFullYear(), now.getMonth(), now.getDate());
		const from = new SvelteDate(to);
		from.setDate(from.getDate() - 7);
		reportType = 'user_activity';
		reportFromDate = from.toISOString().slice(0, 10);
		reportToDate = to.toISOString().slice(0, 10);
		reportFormat = 'json';
		reportResultDelivery = 'auto';
		reportStorageDestinationId = '';
		createReportError = '';
		showCreateReportDialog = true;
	}

	function closeCreateReportDialog() {
		showCreateReportDialog = false;
	}

	function openCreateImportDialog() {
		importFile = null;
		importSkipHeader = true;
		importOnDuplicate = 'skip';
		importValidateOnly = false;
		createImportError = '';
		showCreateImportDialog = true;
	}

	function closeCreateImportDialog() {
		showCreateImportDialog = false;
	}

	function handleImportFileChange(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		importFile = input.files?.[0] ?? null;
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
			const fromDate = reportFromDate
				? new Date(reportFromDate).toISOString()
				: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
			const toDate = reportToDate ? new Date(reportToDate).toISOString() : new Date().toISOString();

			const job = await adminJobsAPI.createReport({
				type: reportType,
				from_date: fromDate,
				to_date: toDate,
				format: reportFormat,
				result_delivery: reportResultDelivery,
				result_storage_destination_id: reportStorageDestinationId || undefined
			});
			if (reportStorageDestinationId) {
				await adminStorageDestinationsAPI.recordUsage(reportStorageDestinationId, {
					feature: 'jobs',
					resource_type: 'admin_job',
					resource_id: job.id,
					metadata: { report_type: reportType, result_delivery: reportResultDelivery }
				});
			}
			jobs = [sanitizeJob(job), ...jobs];
			closeCreateReportDialog();
		} catch (e) {
			createReportError = e instanceof Error ? e.message : 'Failed to create report job';
		} finally {
			creatingReport = false;
		}
	}

	async function handleCreateImport() {
		createImportError = '';
		if (!importFile) {
			createImportError = 'CSV file is required';
			return;
		}

		creatingImport = true;
		try {
			const upload = await adminJobsAPI.getUploadUrl(
				importFile.name,
				importFile.type || 'text/csv',
				importFile.size
			);
			const uploaded = await adminJobsAPI.uploadImportFile(upload.upload_url, importFile);
			const job = await adminJobsAPI.createUserImport({
				file_key: uploaded.file_key || upload.file_key,
				options: {
					skip_header: importSkipHeader,
					on_duplicate: importOnDuplicate,
					validate_only: importValidateOnly
				}
			});
			jobs = [sanitizeJob(job), ...jobs];
			closeCreateImportDialog();
		} catch (e) {
			createImportError = e instanceof Error ? e.message : 'Failed to create import job';
		} finally {
			creatingImport = false;
		}
	}

	async function refreshSelectedJob(jobId: string) {
		const updatedJob = sanitizeJob(await adminJobsAPI.get(jobId));
		if (
			updatedJob.status === 'completed' ||
			updatedJob.status === 'partial_failure' ||
			updatedJob.status === 'failed'
		) {
			try {
				updatedJob.result = await adminJobsAPI.getResult(jobId);
			} catch {
				// Result may not exist for infrastructure failures.
			}
		}
		selectedJob = updatedJob;
	}

	async function viewJobDetail(job: Job) {
		selectedJob = sanitizeJob(job);
		showJobDetailDialog = true;
		loadingJobDetail = true;

		try {
			await refreshSelectedJob(job.id);
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
		if (job.status === 'partial_failure') return 100;
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
			case 'partial_failure':
				return 'badge badge-warning';
			case 'failed':
				return 'badge badge-danger';
			case 'cancelled':
				return 'badge badge-neutral';
			default:
				return 'badge badge-neutral';
		}
	}

	function getDeliveryLabel(value: 'auto' | 'inline' | 'artifact'): string {
		const labels = {
			auto: 'Auto',
			inline: 'Inline',
			artifact: 'Artifact'
		};
		return labels[value];
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
			} else if (showCreateImportDialog) {
				closeCreateImportDialog();
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
			<button class="btn btn-secondary" onclick={openCreateImportDialog}>
				<i class="i-ph-upload-simple"></i>
				Import Users
			</button>
			<button class="btn btn-primary" onclick={openCreateReportDialog}>
				<i class="i-ph-file-text"></i>
				Generate Report
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if jobTypeError}
		<div class="alert alert-warning">{jobTypeError}</div>
	{/if}

	{#if jobTypes.length > 0}
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">Enabled Job Types</h2>
			</div>
			<div class="job-type-grid">
				{#each jobTypes as jobType (jobType.job_type)}
					<div class="job-type-item">
						<div>
							<div class="cell-primary">{getJobTypeDisplayName(jobType.type)}</div>
							<div class="cell-secondary mono">{jobType.job_type}</div>
						</div>
						<div class="job-type-badges">
							<span class="badge badge-info">{jobType.processor_status}</span>
							{#each jobType.supported_result_delivery as delivery (delivery)}
								<span class="badge badge-neutral">{getDeliveryLabel(delivery)}</span>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		</div>
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
					<option value="partial_failure">Partial Failure</option>
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
						{#if statusFilter}
							<span class="badge badge-neutral">{getJobStatusDisplayName(statusFilter)}</span>
						{/if}
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
									{getJobStatusDisplayName(job.status)}
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

<!-- Create Import Dialog -->
<Modal
	open={showCreateImportDialog}
	onClose={closeCreateImportDialog}
	title="Import Users"
	size="md"
>
	{#if createImportError}
		<div class="alert alert-error">{createImportError}</div>
	{/if}

	<div class="form-group">
		<label for="import-file" class="form-label">CSV File</label>
		<input
			id="import-file"
			type="file"
			accept=".csv,text/csv"
			class="form-input"
			onchange={handleImportFileChange}
		/>
		<p class="muted">
			Expected headers: <code>email</code>, <code>name</code>, <code>given_name</code>,
			<code>family_name</code>, <code>nickname</code>, <code>preferred_username</code>,
			<code>picture</code>, <code>email_verified</code>, <code>phone_number</code>,
			<code>phone_number_verified</code>, <code>user_type</code>, <code>status</code>,
			<code>lifecycle_state</code>, plus any custom claim keys.
		</p>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="import-duplicate" class="form-label">On Duplicate</label>
			<select id="import-duplicate" class="form-select" bind:value={importOnDuplicate}>
				<option value="skip">Skip existing users</option>
				<option value="update">Update existing users</option>
				<option value="error">Fail duplicate rows</option>
			</select>
		</div>
		<div class="form-group">
			<label for="import-header" class="form-label">CSV Header</label>
			<select id="import-header" class="form-select" bind:value={importSkipHeader}>
				<option value={true}>First row is header</option>
				<option value={false}>Use default column order</option>
			</select>
		</div>
	</div>

	<label class="checkbox-row">
		<input type="checkbox" bind:checked={importValidateOnly} />
		<span>Validate only (do not write users)</span>
	</label>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateImportDialog} disabled={creatingImport}
			>Cancel</button
		>
		<button class="btn btn-primary" onclick={handleCreateImport} disabled={creatingImport}>
			{creatingImport ? 'Uploading...' : 'Start Import'}
		</button>
	{/snippet}
</Modal>

<!-- Create Report Dialog -->
<Modal
	open={showCreateReportDialog}
	onClose={closeCreateReportDialog}
	title="Generate Report"
	size="md"
>
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

	<div class="filter-row">
		<div class="form-group">
			<label for="report-format" class="form-label">Format</label>
			<select id="report-format" class="form-select" bind:value={reportFormat}>
				<option value="json">JSON</option>
				<option value="csv">CSV</option>
			</select>
		</div>
		<div class="form-group">
			<label for="report-delivery" class="form-label">Result Delivery</label>
			<select id="report-delivery" class="form-select" bind:value={reportResultDelivery}>
				<option value="auto">Auto</option>
				<option value="inline">Inline</option>
				<option value="artifact">Artifact</option>
			</select>
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="report-storage-destination" class="form-label">Storage Destination</label>
			<select
				id="report-storage-destination"
				class="form-select"
				bind:value={reportStorageDestinationId}
			>
				<option value="">Runtime default</option>
				{#each storageDestinations as destination (destination.id)}
					<option value={destination.id}>{destination.display_name} ({destination.provider})</option
					>
				{/each}
			</select>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateReportDialog} disabled={creatingReport}
			>Cancel</button
		>
		<button class="btn btn-primary" onclick={handleCreateReport} disabled={creatingReport}>
			{creatingReport ? 'Creating...' : 'Generate Report'}
		</button>
	{/snippet}
</Modal>

<!-- Job Detail Dialog -->
<Modal
	open={showJobDetailDialog && !!selectedJob}
	onClose={closeJobDetailDialog}
	title={getJobTypeDisplayName(selectedJob?.type ?? 'report_generation')}
	size="lg"
>
	{#snippet header()}
		<div>
			<h2 class="modal-title">
				{getJobTypeDisplayName(selectedJob?.type ?? 'report_generation')}
			</h2>
			<div class="cell-secondary mono">{selectedJob?.id}</div>
		</div>
		<button class="modal-close" onclick={closeJobDetailDialog} aria-label="Close dialog">
			<i class="i-ph-x"></i>
		</button>
	{/snippet}

	{#if loadingJobDetail}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading...</p>
		</div>
	{:else if selectedJob}
		<div class="info-grid">
			<div class="info-card">
				<span class="info-label">Status</span>
				<span class={getStatusBadgeClass(selectedJob.status)}>
					{getJobStatusDisplayName(selectedJob.status)}
				</span>
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
			<div class="info-card">
				<span class="info-label">Attempts</span>
				<span class="info-value">{selectedJob.attempts}/{selectedJob.max_attempts}</span>
			</div>
			{#if selectedJob.next_run_at}
				<div class="info-card">
					<span class="info-label">Next Run</span>
					<span class="info-value">{formatDate(selectedJob.next_run_at)}</span>
				</div>
			{/if}
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
				{#if selectedJob.progress.stage}
					<p class="muted">Stage: {selectedJob.progress.stage}</p>
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

				{#if selectedJob.progress}
					<p class="muted">
						Processed {selectedJob.progress.processed} of {selectedJob.progress.total}
						{#if selectedJob.progress.succeeded !== undefined}
							({selectedJob.progress.succeeded} succeeded / {selectedJob.progress.failed ?? 0}
							failed / {selectedJob.progress.skipped ?? 0} skipped)
						{/if}
					</p>
				{/if}

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

				{#if selectedJob.result.logs.length > 0}
					<div class="detail-section">
						<h4 class="failures-title">Recent Logs</h4>
						<div class="failures-list">
							{#each selectedJob.result.logs as entry, i (i)}
								<div class="failure-item">
									<strong>{entry.level.toUpperCase()}</strong>
									{#if entry.row}
										row {entry.row}:{/if}
									{entry.message}
								</div>
							{/each}
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

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeJobDetailDialog}>Close</button>
	{/snippet}
</Modal>

<style>
	.job-type-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 12px;
	}

	.job-type-item {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
	}

	.job-type-badges {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}
</style>
