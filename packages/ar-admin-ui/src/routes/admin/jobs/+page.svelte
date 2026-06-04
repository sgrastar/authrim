<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteDate } from 'svelte/reactivity';
	import {
		adminJobsAPI,
		getJobStatusColor,
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
	import { LL } from '$i18n/i18n-svelte';

	// State
	let loading = $state(true);
	let error = $state('');
	let jobs = $state<Job[]>([]);
	let jobTypes = $state<JobTypeDefinition[]>([]);
	let jobTypeError = $state('');
	let selectedJobType = $state<JobTypeDefinition | null>(null);

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

	const jobSummary = $derived({
		total: jobs.length,
		active: jobs.filter((job) => job.status === 'pending' || job.status === 'running').length,
		failed: jobs.filter((job) => job.status === 'failed' || job.status === 'partial_failure')
			.length,
		completed: jobs.filter((job) => job.status === 'completed').length
	});
	const activeFilterCount = $derived([statusFilter, typeFilter].filter(Boolean).length);

	// Create Import Dialog
	let showCreateImportDialog = $state(false);
	let creatingImport = $state(false);
	let createImportError = $state('');
	let importFile = $state<File | null>(null);
	let importSkipHeader = $state(true);
	let importOnDuplicate = $state<'skip' | 'update' | 'error'>('skip');
	let importValidateOnly = $state(false);

	// Tenant DB Provisioning Dialog
	let showTenantDbDialog = $state(false);
	let creatingTenantDbRequest = $state(false);
	let tenantDbRequestError = $state('');
	let tenantDbSlug = $state('');
	let tenantDbGeneration = $state('1');
	let tenantDbActivate = $state(false);
	let tenantDbExecutionMode = $state<'plan_only' | 'operator_cli'>('plan_only');
	let tenantDbReason = $state('');

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
			error = e instanceof Error ? e.message : $LL.admin_jobs_load_failed();
		}
	}

	async function loadJobTypes() {
		try {
			const response = await adminJobsAPI.listTypes();
			jobTypes = response.job_types.filter((jobType) => jobType.creatable_from_admin_api);
			jobTypeError = '';
		} catch (e) {
			jobTypeError = e instanceof Error ? e.message : $LL.admin_jobs_load_types_failed();
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

	function openTenantDbDialog() {
		tenantDbSlug = '';
		tenantDbGeneration = '1';
		tenantDbActivate = false;
		tenantDbExecutionMode = 'plan_only';
		tenantDbReason = '';
		tenantDbRequestError = '';
		showTenantDbDialog = true;
	}

	function closeTenantDbDialog() {
		showTenantDbDialog = false;
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
					createReportError = $LL.admin_jobs_from_before_to_error();
					return;
				}

				// Check for future dates
				if (to > today) {
					createReportError = $LL.admin_jobs_to_future_error();
					return;
				}

				// Check date range limit
				const daysDiff = Math.ceil((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
				if (daysDiff > MAX_DATE_RANGE_DAYS) {
					createReportError = $LL.admin_jobs_date_range_error({
						days: MAX_DATE_RANGE_DAYS,
						years: Math.floor(MAX_DATE_RANGE_DAYS / 365)
					});
					return;
				}
			}

			// Single date validation
			if (reportToDate) {
				const to = new Date(reportToDate);
				if (to > today) {
					createReportError = $LL.admin_jobs_to_future_error();
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
			createReportError = e instanceof Error ? e.message : $LL.admin_jobs_create_report_failed();
		} finally {
			creatingReport = false;
		}
	}

	async function handleCreateImport() {
		createImportError = '';
		if (!importFile) {
			createImportError = $LL.admin_jobs_csv_required();
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
			createImportError = e instanceof Error ? e.message : $LL.admin_jobs_create_import_failed();
		} finally {
			creatingImport = false;
		}
	}

	async function handleCreateTenantDbRequest() {
		tenantDbRequestError = '';
		const generation = Number.parseInt(tenantDbGeneration, 10);
		if (!Number.isInteger(generation) || generation < 1) {
			tenantDbRequestError = $LL.admin_jobs_generation_positive_integer();
			return;
		}

		creatingTenantDbRequest = true;
		try {
			const job = await adminJobsAPI.createTenantDatabaseProvision({
				tenant_slug: tenantDbSlug.trim() || undefined,
				generation,
				activate: tenantDbActivate,
				execution_mode: tenantDbExecutionMode,
				reason: tenantDbReason.trim() || undefined
			});
			jobs = [sanitizeJob(job), ...jobs];
			closeTenantDbDialog();
		} catch (e) {
			tenantDbRequestError =
				e instanceof Error ? e.message : $LL.admin_jobs_create_tenant_db_failed();
		} finally {
			creatingTenantDbRequest = false;
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

	function viewJobTypeDetail(jobType: JobTypeDefinition) {
		selectedJobType = jobType;
	}

	function closeJobTypeDetail() {
		selectedJobType = null;
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
			auto: $LL.admin_jobs_delivery_auto(),
			inline: $LL.admin_jobs_delivery_inline(),
			artifact: $LL.admin_jobs_delivery_artifact()
		};
		return labels[value];
	}

	function getDeliveryDescription(value: 'auto' | 'inline' | 'artifact'): string {
		const descriptions = {
			auto: $LL.admin_jobs_delivery_auto_description(),
			inline: $LL.admin_jobs_delivery_inline_description(),
			artifact: $LL.admin_jobs_delivery_artifact_description()
		};
		return descriptions[value];
	}

	function getProcessorDescription(value: JobTypeDefinition['processor_status']): string {
		if (value === 'scheduled') {
			return $LL.admin_jobs_processor_scheduled();
		}
		if (value === 'inline') {
			return $LL.admin_jobs_processor_inline();
		}
		return $LL.admin_jobs_processor_disabled();
	}

	function getJobStatusLabel(status: JobStatus): string {
		const labels: Record<JobStatus, string> = {
			pending: $LL.admin_jobs_status_pending(),
			running: $LL.admin_jobs_status_running(),
			completed: $LL.admin_jobs_status_completed(),
			partial_failure: $LL.admin_jobs_status_partial_failure(),
			failed: $LL.admin_jobs_status_failed(),
			cancelled: $LL.admin_jobs_status_cancelled()
		};
		return labels[status] ?? $LL.admin_jobs_status_unknown();
	}

	function getJobTypeLabel(type: JobType): string {
		const labels: Record<JobType, string> = {
			users_import: $LL.admin_jobs_type_users_import(),
			users_bulk_update: $LL.admin_jobs_type_users_bulk_update(),
			report_generation: $LL.admin_jobs_type_report_generation(),
			org_bulk_members: $LL.admin_jobs_type_org_bulk_members(),
			tenant_delete: $LL.admin_jobs_type_tenant_delete(),
			tenant_database_provision: $LL.admin_jobs_type_tenant_database_provision(),
			tenant_database_activate_batch: $LL.admin_jobs_type_tenant_database_activate_batch(),
			tenant_database_export: $LL.admin_jobs_type_tenant_database_export(),
			tenant_database_restore_dry_run: $LL.admin_jobs_type_tenant_database_restore_dry_run(),
			tenant_database_purge_backup: $LL.admin_jobs_type_tenant_database_purge_backup()
		};
		return labels[type] ?? $LL.admin_jobs_type_unknown();
	}

	function getReportTypeLabel(type: ReportType): string {
		const labels: Record<ReportType, string> = {
			user_activity: $LL.admin_jobs_report_user_activity(),
			access_summary: $LL.admin_jobs_report_access_summary(),
			compliance_audit: $LL.admin_jobs_report_compliance_audit(),
			security_events: $LL.admin_jobs_report_security_events()
		};
		return labels[type] ?? $LL.admin_jobs_report_unknown();
	}

	function clearFilters() {
		statusFilter = '';
		typeFilter = '';
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
			if (selectedJobType) {
				closeJobTypeDetail();
			} else if (showJobDetailDialog) {
				closeJobDetailDialog();
			} else if (showTenantDbDialog) {
				closeTenantDbDialog();
			} else if (showCreateImportDialog) {
				closeCreateImportDialog();
			} else if (showCreateReportDialog) {
				closeCreateReportDialog();
			}
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_jobs_page_title()}</title>
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_jobs_title()}</h1>
			<p class="page-description">
				{$LL.admin_jobs_description()}
			</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={openTenantDbDialog}>
				<i class="i-ph-database"></i>
				{$LL.admin_jobs_tenant_db()}
			</button>
			<button class="btn btn-secondary" onclick={openCreateImportDialog}>
				<i class="i-ph-upload-simple"></i>
				{$LL.admin_jobs_import_users()}
			</button>
			<button class="btn btn-primary" onclick={openCreateReportDialog}>
				<i class="i-ph-file-text"></i>
				{$LL.admin_jobs_create_report_job()}
			</button>
		</div>
	</div>

	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}
	{#if jobTypeError}
		<div class="alert alert-warning">{jobTypeError}</div>
	{/if}

	<div class="job-summary-grid">
		<div class="summary-card">
			<span class="summary-label">{$LL.admin_jobs_total_jobs()}</span>
			<strong>{jobSummary.total}</strong>
		</div>
		<div class="summary-card">
			<span class="summary-label">{$LL.admin_jobs_active()}</span>
			<strong>{jobSummary.active}</strong>
		</div>
		<div class="summary-card">
			<span class="summary-label">{$LL.admin_jobs_completed()}</span>
			<strong>{jobSummary.completed}</strong>
		</div>
		<div class="summary-card warning">
			<span class="summary-label">{$LL.admin_jobs_needs_attention()}</span>
			<strong>{jobSummary.failed}</strong>
		</div>
	</div>

	{#if jobTypes.length > 0}
		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">{$LL.admin_jobs_creatable_types_title()}</h2>
					<p class="panel-description">
						{$LL.admin_jobs_creatable_types_description()}
					</p>
				</div>
			</div>
			<div class="job-type-grid">
				{#each jobTypes as jobType (jobType.job_type)}
					<button class="job-type-item" onclick={() => viewJobTypeDetail(jobType)}>
						<div>
							<div class="cell-primary">{getJobTypeLabel(jobType.type)}</div>
							<div class="cell-secondary mono">{jobType.job_type}</div>
						</div>
						<div class="job-type-badges">
							<span class="badge badge-info">{jobType.processor_status}</span>
							{#each jobType.supported_result_delivery as delivery (delivery)}
								<span class="badge badge-neutral">{getDeliveryLabel(delivery)}</span>
							{/each}
						</div>
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="panel-header">
			<div>
				<h2 class="panel-title">{$LL.admin_jobs_queue_title()}</h2>
				<p class="panel-description">{$LL.admin_jobs_queue_description()}</p>
			</div>
			{#if activeFilterCount > 0}
				<button class="btn btn-secondary btn-sm" onclick={clearFilters}
					>{$LL.admin_jobs_clear_filters()}</button
				>
			{/if}
		</div>
		<div class="filter-row">
			<div class="form-group">
				<label for="status-filter" class="form-label">{$LL.admin_jobs_status()}</label>
				<select id="status-filter" class="form-select" bind:value={statusFilter}>
					<option value="">{$LL.admin_jobs_all_status()}</option>
					<option value="pending">{$LL.admin_jobs_status_pending()}</option>
					<option value="running">{$LL.admin_jobs_status_running()}</option>
					<option value="completed">{$LL.admin_jobs_status_completed()}</option>
					<option value="partial_failure">{$LL.admin_jobs_status_partial_failure()}</option>
					<option value="failed">{$LL.admin_jobs_status_failed()}</option>
					<option value="cancelled">{$LL.admin_jobs_status_cancelled()}</option>
				</select>
			</div>
			<div class="form-group">
				<label for="type-filter" class="form-label">{$LL.admin_jobs_type()}</label>
				<select id="type-filter" class="form-select" bind:value={typeFilter}>
					<option value="">{$LL.admin_jobs_all_types()}</option>
					<option value="users_import">{$LL.admin_jobs_type_users_import()}</option>
					<option value="users_bulk_update">{$LL.admin_jobs_type_users_bulk_update()}</option>
					<option value="report_generation">{$LL.admin_jobs_type_report_generation()}</option>
					<option value="org_bulk_members">{$LL.admin_jobs_type_org_bulk_members()}</option>
					<option value="tenant_delete">{$LL.admin_jobs_type_tenant_delete()}</option>
					<option value="tenant_database_provision"
						>{$LL.admin_jobs_type_tenant_database_provision()}</option
					>
					<option value="tenant_database_activate_batch"
						>{$LL.admin_jobs_type_tenant_database_activate_batch()}</option
					>
					<option value="tenant_database_export"
						>{$LL.admin_jobs_type_tenant_database_export()}</option
					>
					<option value="tenant_database_restore_dry_run"
						>{$LL.admin_jobs_type_tenant_database_restore_dry_run()}</option
					>
					<option value="tenant_database_purge_backup"
						>{$LL.admin_jobs_type_tenant_database_purge_backup()}</option
					>
				</select>
			</div>
			<div class="form-group form-group-action">
				<button class="btn btn-secondary" onclick={loadData} disabled={loading}>
					<i class="i-ph-arrows-clockwise"></i>
					{$LL.admin_jobs_refresh()}
				</button>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_jobs_loading_jobs()}</p>
		</div>
	{:else if jobs.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">{$LL.admin_jobs_no_jobs()}</p>
				{#if statusFilter || typeFilter}
					<p class="empty-state-hint">
						{$LL.admin_jobs_current_filters()}
						{#if statusFilter}
							<span class="badge badge-neutral">{getJobStatusLabel(statusFilter)}</span>
						{/if}
						{#if typeFilter}<span class="badge badge-neutral">{getJobTypeLabel(typeFilter)}</span
							>{/if}
					</p>
					<button class="btn btn-secondary" onclick={clearFilters}>
						{$LL.admin_jobs_clear_filters()}
					</button>
				{:else}
					<p class="empty-state-hint">
						{$LL.admin_jobs_empty_hint()}
					</p>
				{/if}
			</div>
		</div>
	{:else}
		<div class="data-table-container jobs-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_jobs_type()}</th>
						<th>{$LL.admin_jobs_status()}</th>
						<th>{$LL.admin_jobs_progress()}</th>
						<th>{$LL.admin_jobs_duration()}</th>
						<th>{$LL.admin_jobs_created()}</th>
						<th class="text-right">{$LL.admin_jobs_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each jobs as job (job.id)}
						<tr class:row-active={job.status === 'pending' || job.status === 'running'}>
							<td>
								<div class="cell-primary">{getJobTypeLabel(job.type)}</div>
								<div class="cell-secondary mono">{job.id.substring(0, 8)}...</div>
							</td>
							<td>
								<span class={getStatusBadgeClass(job.status)}>
									{#if job.status === 'running'}
										<span class="pulse-dot"></span>
									{/if}
									{getJobStatusLabel(job.status)}
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
									<i class="i-ph-sidebar-simple"></i>
									{$LL.admin_jobs_details()}
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Tenant DB Provisioning Dialog -->
<Modal
	open={showTenantDbDialog}
	onClose={closeTenantDbDialog}
	title={$LL.admin_jobs_tenant_database_request()}
	size="md"
>
	{#if tenantDbRequestError}
		<div class="alert alert-error">{tenantDbRequestError}</div>
	{/if}

	<div class="form-group">
		<label for="tenant-db-slug" class="form-label">{$LL.admin_jobs_tenant_slug()}</label>
		<input id="tenant-db-slug" type="text" class="form-input" bind:value={tenantDbSlug} />
		<p class="form-hint">{$LL.admin_jobs_tenant_slug_hint()}</p>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="tenant-db-generation" class="form-label">{$LL.admin_jobs_generation()}</label>
			<input
				id="tenant-db-generation"
				type="number"
				min="1"
				class="form-input"
				bind:value={tenantDbGeneration}
			/>
		</div>
		<div class="form-group">
			<label for="tenant-db-execution" class="form-label">{$LL.admin_jobs_execution()}</label>
			<select id="tenant-db-execution" class="form-select" bind:value={tenantDbExecutionMode}>
				<option value="plan_only">{$LL.admin_jobs_execution_plan_only()}</option>
				<option value="operator_cli">{$LL.admin_jobs_execution_operator_cli()}</option>
			</select>
		</div>
	</div>

	<label class="checkbox-row">
		<input type="checkbox" bind:checked={tenantDbActivate} />
		<span>{$LL.admin_jobs_activate_after_deploy()}</span>
	</label>

	<div class="form-group">
		<label for="tenant-db-reason" class="form-label">{$LL.admin_jobs_reason()}</label>
		<textarea id="tenant-db-reason" class="form-textarea" rows="3" bind:value={tenantDbReason}
		></textarea>
		<p class="form-hint">{$LL.admin_jobs_reason_hint()}</p>
	</div>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={closeTenantDbDialog}
			disabled={creatingTenantDbRequest}>{$LL.admin_jobs_cancel()}</button
		>
		<button
			class="btn btn-primary"
			onclick={handleCreateTenantDbRequest}
			disabled={creatingTenantDbRequest}
		>
			{creatingTenantDbRequest ? $LL.admin_jobs_creating() : $LL.admin_jobs_create_request()}
		</button>
	{/snippet}
</Modal>

<!-- Create Import Dialog -->
<Modal
	open={showCreateImportDialog}
	onClose={closeCreateImportDialog}
	title={$LL.admin_jobs_import_users()}
	size="md"
>
	{#if createImportError}
		<div class="alert alert-error">{createImportError}</div>
	{/if}

	<div class="form-group">
		<label for="import-file" class="form-label">{$LL.admin_jobs_csv_file()}</label>
		<input
			id="import-file"
			type="file"
			accept=".csv,text/csv"
			class="form-input"
			onchange={handleImportFileChange}
		/>
		<p class="muted">
			{$LL.admin_jobs_expected_headers()} <code>email</code>, <code>name</code>,
			<code>given_name</code>,
			<code>family_name</code>, <code>nickname</code>, <code>preferred_username</code>,
			<code>picture</code>, <code>email_verified</code>, <code>phone_number</code>,
			<code>phone_number_verified</code>, <code>user_type</code>, <code>status</code>,
			<code>lifecycle_state</code>, {$LL.admin_jobs_custom_claim_keys_suffix()}
		</p>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="import-duplicate" class="form-label">{$LL.admin_jobs_on_duplicate()}</label>
			<select id="import-duplicate" class="form-select" bind:value={importOnDuplicate}>
				<option value="skip">{$LL.admin_jobs_duplicate_skip()}</option>
				<option value="update">{$LL.admin_jobs_duplicate_update()}</option>
				<option value="error">{$LL.admin_jobs_duplicate_error()}</option>
			</select>
		</div>
		<div class="form-group">
			<label for="import-header" class="form-label">{$LL.admin_jobs_csv_header()}</label>
			<select id="import-header" class="form-select" bind:value={importSkipHeader}>
				<option value={true}>{$LL.admin_jobs_first_row_header()}</option>
				<option value={false}>{$LL.admin_jobs_default_column_order()}</option>
			</select>
		</div>
	</div>

	<label class="checkbox-row">
		<input type="checkbox" bind:checked={importValidateOnly} />
		<span>{$LL.admin_jobs_validate_only()}</span>
	</label>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateImportDialog} disabled={creatingImport}
			>{$LL.admin_jobs_cancel()}</button
		>
		<button class="btn btn-primary" onclick={handleCreateImport} disabled={creatingImport}>
			{creatingImport ? $LL.admin_jobs_uploading() : $LL.admin_jobs_start_import()}
		</button>
	{/snippet}
</Modal>

<!-- Create Report Dialog -->
<Modal
	open={showCreateReportDialog}
	onClose={closeCreateReportDialog}
	title={$LL.admin_jobs_create_report_job()}
	size="md"
>
	{#if createReportError}
		<div class="alert alert-error">{createReportError}</div>
	{/if}

	<div class="form-group">
		<label for="report-type" class="form-label">{$LL.admin_jobs_report_type()}</label>
		<select id="report-type" class="form-select" bind:value={reportType}>
			<option value="user_activity">{getReportTypeLabel('user_activity')}</option>
			<option value="access_summary">{getReportTypeLabel('access_summary')}</option>
			<option value="compliance_audit">{getReportTypeLabel('compliance_audit')}</option>
			<option value="security_events">{getReportTypeLabel('security_events')}</option>
		</select>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="report-from" class="form-label">{$LL.admin_jobs_from_date_optional()}</label>
			<input id="report-from" type="date" class="form-input" bind:value={reportFromDate} />
		</div>
		<div class="form-group">
			<label for="report-to" class="form-label">{$LL.admin_jobs_to_date_optional()}</label>
			<input id="report-to" type="date" class="form-input" bind:value={reportToDate} />
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="report-format" class="form-label">{$LL.admin_jobs_format()}</label>
			<select id="report-format" class="form-select" bind:value={reportFormat}>
				<option value="json">JSON</option>
				<option value="csv">CSV</option>
			</select>
		</div>
		<div class="form-group">
			<label for="report-delivery" class="form-label">{$LL.admin_jobs_result_delivery()}</label>
			<select id="report-delivery" class="form-select" bind:value={reportResultDelivery}>
				<option value="auto">{$LL.admin_jobs_delivery_auto()}</option>
				<option value="inline">{$LL.admin_jobs_delivery_inline()}</option>
				<option value="artifact">{$LL.admin_jobs_delivery_artifact()}</option>
			</select>
		</div>
	</div>

	<div class="filter-row">
		<div class="form-group">
			<label for="report-storage-destination" class="form-label"
				>{$LL.admin_jobs_storage_destination()}</label
			>
			<select
				id="report-storage-destination"
				class="form-select"
				bind:value={reportStorageDestinationId}
			>
				<option value="">{$LL.admin_jobs_runtime_default()}</option>
				{#each storageDestinations as destination (destination.id)}
					<option value={destination.id}>{destination.display_name} ({destination.provider})</option
					>
				{/each}
			</select>
			<p class="form-hint">{$LL.admin_jobs_storage_destination_hint()}</p>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateReportDialog} disabled={creatingReport}
			>{$LL.admin_jobs_cancel()}</button
		>
		<button class="btn btn-primary" onclick={handleCreateReport} disabled={creatingReport}>
			{creatingReport ? $LL.admin_jobs_creating() : $LL.admin_jobs_create_report_job()}
		</button>
	{/snippet}
</Modal>

<!-- Job Type Detail Dialog -->
<Modal
	open={!!selectedJobType}
	onClose={closeJobTypeDetail}
	title={selectedJobType ? getJobTypeLabel(selectedJobType.type) : $LL.admin_jobs_job_type()}
	size="md"
>
	{#if selectedJobType}
		<div class="job-type-detail">
			<div class="info-grid">
				<div class="info-card">
					<span class="info-label">{$LL.admin_jobs_catalog_key()}</span>
					<span class="info-value mono">{selectedJobType.job_type}</span>
				</div>
				<div class="info-card">
					<span class="info-label">{$LL.admin_jobs_processor()}</span>
					<span class="badge badge-info">{selectedJobType.processor_status}</span>
				</div>
				<div class="info-card">
					<span class="info-label">{$LL.admin_jobs_create_endpoint()}</span>
					<span class="info-value mono"
						>{selectedJobType.create_endpoint ?? $LL.admin_jobs_not_exposed()}</span
					>
				</div>
				<div class="info-card">
					<span class="info-label">{$LL.admin_jobs_result_object()}</span>
					<span class="info-value mono"
						>{selectedJobType.result_object_class ?? $LL.admin_jobs_none()}</span
					>
				</div>
			</div>

			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_jobs_processor_mode()}</h3>
				<p class="detail-copy">
					{getProcessorDescription(selectedJobType.processor_status)}
				</p>
			</div>

			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_jobs_result_delivery_title()}</h3>
				<div class="delivery-list">
					{#each selectedJobType.supported_result_delivery as delivery (delivery)}
						<div class="delivery-item">
							<span class="badge badge-neutral">{getDeliveryLabel(delivery)}</span>
							<span>{getDeliveryDescription(delivery)}</span>
						</div>
					{/each}
				</div>
			</div>

			{#if selectedJobType.notes}
				<div class="detail-section">
					<h3 class="detail-section-title">{$LL.admin_jobs_notes()}</h3>
					<p class="detail-copy">{selectedJobType.notes}</p>
				</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeJobTypeDetail}>{$LL.admin_jobs_close()}</button>
	{/snippet}
</Modal>

<!-- Job Detail Dialog -->
<Modal
	open={showJobDetailDialog && !!selectedJob}
	onClose={closeJobDetailDialog}
	title={getJobTypeLabel(selectedJob?.type ?? 'report_generation')}
	size="lg"
>
	{#snippet header()}
		<div>
			<h2 class="modal-title">
				{getJobTypeLabel(selectedJob?.type ?? 'report_generation')}
			</h2>
			<div class="cell-secondary mono">{selectedJob?.id}</div>
		</div>
		<button
			class="modal-close"
			onclick={closeJobDetailDialog}
			aria-label={$LL.admin_jobs_close_dialog()}
		>
			<i class="i-ph-x"></i>
		</button>
	{/snippet}

	{#if loadingJobDetail}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_jobs_loading()}</p>
		</div>
	{:else if selectedJob}
		<div class="info-grid">
			<div class="info-card">
				<span class="info-label">{$LL.admin_jobs_status()}</span>
				<span class={getStatusBadgeClass(selectedJob.status)}>
					{getJobStatusLabel(selectedJob.status)}
				</span>
			</div>
			<div class="info-card">
				<span class="info-label">{$LL.admin_jobs_duration()}</span>
				<span class="info-value"
					>{formatJobDuration(selectedJob.started_at, selectedJob.completed_at)}</span
				>
			</div>
			<div class="info-card">
				<span class="info-label">{$LL.admin_jobs_created()}</span>
				<span class="info-value">{formatDate(selectedJob.created_at)}</span>
			</div>
			<div class="info-card">
				<span class="info-label">{$LL.admin_jobs_created_by()}</span>
				<span class="info-value">{selectedJob.created_by}</span>
			</div>
			<div class="info-card">
				<span class="info-label">{$LL.admin_jobs_attempts()}</span>
				<span class="info-value">{selectedJob.attempts}/{selectedJob.max_attempts}</span>
			</div>
			{#if selectedJob.next_run_at}
				<div class="info-card">
					<span class="info-label">{$LL.admin_jobs_next_run()}</span>
					<span class="info-value">{formatDate(selectedJob.next_run_at)}</span>
				</div>
			{/if}
		</div>

		{#if selectedJob.progress}
			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_jobs_progress()}</h3>
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
					<p class="muted">
						{$LL.admin_jobs_processing({ item: selectedJob.progress.current_item })}
					</p>
				{/if}
				{#if selectedJob.progress.stage}
					<p class="muted">{$LL.admin_jobs_stage({ stage: selectedJob.progress.stage })}</p>
				{/if}
			</div>
		{/if}

		{#if selectedJob.result}
			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_jobs_result_summary()}</h3>
				<div class="result-grid">
					<div class="result-card success">
						<span class="result-value">{selectedJob.result.summary.success_count}</span>
						<span class="result-label">{$LL.admin_jobs_succeeded()}</span>
					</div>
					<div class="result-card danger">
						<span class="result-value">{selectedJob.result.summary.failure_count}</span>
						<span class="result-label">{$LL.admin_jobs_failed()}</span>
					</div>
					<div class="result-card neutral">
						<span class="result-value">{selectedJob.result.summary.skipped_count}</span>
						<span class="result-label">{$LL.admin_jobs_skipped()}</span>
					</div>
				</div>

				{#if selectedJob.progress}
					<p class="muted">
						{$LL.admin_jobs_processed_summary({
							processed: selectedJob.progress.processed,
							total: selectedJob.progress.total
						})}
						{#if selectedJob.progress.succeeded !== undefined}
							{$LL.admin_jobs_processed_detail({
								succeeded: selectedJob.progress.succeeded,
								failed: selectedJob.progress.failed ?? 0,
								skipped: selectedJob.progress.skipped ?? 0
							})}
						{/if}
					</p>
				{/if}

				{#if selectedJob.result.failures.length > 0}
					<div class="failures-section">
						<h4 class="failures-title">
							{$LL.admin_jobs_failures({ count: selectedJob.result.failures.length })}
						</h4>
						<div class="failures-list">
							{#each selectedJob.result.failures.slice(0, 10) as failure, i (i)}
								<div class="failure-item">
									{#if failure.line}{$LL.admin_jobs_line_error({ line: failure.line })}
									{/if}{failure.error || $LL.admin_jobs_unknown_error()}
								</div>
							{/each}
							{#if selectedJob.result.failures.length > 10}
								<div class="muted">
									{$LL.admin_jobs_more_failures({
										count: selectedJob.result.failures.length - 10
									})}
								</div>
							{/if}
						</div>
					</div>
				{/if}

				{#if selectedJob.result.logs.length > 0}
					<div class="detail-section">
						<h4 class="failures-title">{$LL.admin_jobs_recent_logs()}</h4>
						<div class="failures-list">
							{#each selectedJob.result.logs as entry, i (i)}
								<div class="failure-item">
									<strong>{entry.level.toUpperCase()}</strong>
									{#if entry.row}
										{$LL.admin_jobs_row({ row: entry.row })}{/if}
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
						{$LL.admin_jobs_download_result()}
					</a>
				{/if}
			</div>
		{/if}

		{#if selectedJob.parameters && Object.keys(selectedJob.parameters).length > 0}
			<div class="detail-section">
				<h3 class="detail-section-title">{$LL.admin_jobs_parameters()}</h3>
				<pre class="code-block">{JSON.stringify(selectedJob.parameters, null, 2)}</pre>
			</div>
		{/if}
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeJobDetailDialog}
			>{$LL.admin_jobs_close()}</button
		>
	{/snippet}
</Modal>

<style>
	.job-summary-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1rem;
	}

	.summary-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		padding: 1rem;
	}

	.summary-card.warning {
		border-color: color-mix(in srgb, var(--warning, #f59e0b) 30%, var(--border));
	}

	.summary-label {
		display: block;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		margin-bottom: 0.35rem;
	}

	.summary-card strong {
		color: var(--text-primary);
		font-size: 1.35rem;
		line-height: 1;
	}

	.panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.panel-description {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
	}

	.job-type-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: 0.75rem;
	}

	.job-type-item {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			background var(--transition-fast),
			border-color var(--transition-fast),
			transform var(--transition-fast);
	}

	.job-type-item:hover {
		border-color: color-mix(in srgb, var(--primary) 32%, var(--border));
		background: color-mix(in srgb, var(--primary) 5%, var(--bg-subtle));
		transform: translateY(-1px);
	}

	.job-type-item:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--primary) 45%, transparent);
		outline-offset: 2px;
	}

	.job-type-badges {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 0.375rem;
	}

	.jobs-table-container {
		border-radius: var(--radius-lg);
	}

	.data-table tbody tr.row-active {
		background: color-mix(in srgb, var(--primary, #2563eb) 4%, var(--bg-card));
	}

	.progress-cell {
		min-width: 160px;
	}

	.progress-bar,
	.progress-bar-lg {
		overflow: hidden;
		border-radius: var(--radius-full);
		background: var(--bg-subtle);
		border: 1px solid var(--border);
	}

	.progress-bar {
		width: 100%;
		height: 0.55rem;
		margin-bottom: 0.35rem;
	}

	.progress-bar-lg {
		height: 0.75rem;
		flex: 1;
	}

	.progress-fill {
		height: 100%;
		border-radius: inherit;
		transition: width var(--transition-fast);
	}

	.progress-text {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-variant-numeric: tabular-nums;
	}

	.pulse-dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: var(--radius-full);
		background: currentColor;
		box-shadow: 0 0 0 4px color-mix(in srgb, currentColor 16%, transparent);
	}

	.form-hint {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.4;
		margin: 0.4rem 0 0;
	}

	.progress-detail {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.info-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		padding: 0.75rem;
		min-width: 0;
	}

	.info-card .info-value {
		display: block;
		overflow-wrap: anywhere;
	}

	.detail-section {
		padding-top: 1rem;
		border-top: 1px solid var(--border);
	}

	.detail-section-title {
		margin: 0 0 0.625rem;
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.job-type-detail {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.detail-copy {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.55;
	}

	.delivery-list {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}

	.delivery-item {
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
	}

	@media (max-width: 900px) {
		.job-summary-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	@media (max-width: 640px) {
		.job-summary-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
