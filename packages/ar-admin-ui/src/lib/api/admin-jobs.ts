import { adminFetch } from '$lib/api/admin-request';
/**
 * Admin Jobs API Client
 *
 * Provides methods for managing async background jobs including
 * user imports, bulk updates, and report generation.
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
 * Job types
 */
export type JobType =
	| 'users_import'
	| 'users_bulk_update'
	| 'report_generation'
	| 'org_bulk_members';

/**
 * Job status
 */
export type JobStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'partial_failure'
	| 'failed'
	| 'cancelled';

/**
 * Job progress info
 */
export interface JobProgress {
	processed: number;
	total: number;
	percentage: number;
	current_item?: string;
	stage?: string;
	succeeded?: number;
	failed?: number;
	skipped?: number;
}

/**
 * Job result summary
 */
export interface JobResultSummary {
	success_count: number;
	failure_count: number;
	skipped_count: number;
	warnings: string[];
}

/**
 * Job failure entry
 */
export interface JobFailure {
	line?: number;
	item?: string;
	error: string;
	code?: string;
}

export interface JobLogEntry {
	timestamp: string;
	level: 'info' | 'warn' | 'error';
	code: string;
	message: string;
	row?: number;
	email?: string;
}

/**
 * Job result
 */
export interface JobResult {
	summary: JobResultSummary;
	failures: JobFailure[];
	logs: JobLogEntry[];
	artifact_id?: string;
	available_formats?: Array<'json' | 'csv'>;
	manifest_url?: string;
	download_url?: string;
}

/**
 * Job entry
 */
export interface Job {
	id: string;
	tenant_id: string;
	type: JobType;
	status: JobStatus;
	progress?: JobProgress;
	result?: JobResult;
	created_by: string;
	created_at: string;
	started_at?: string;
	completed_at?: string;
	parameters?: Record<string, unknown>;
}

/**
 * Report types for report generation jobs
 */
export type ReportType =
	| 'user_activity'
	| 'access_summary'
	| 'compliance_audit'
	| 'security_events';

/**
 * User import options
 */
export interface UserImportOptions {
	skip_header?: boolean;
	on_duplicate?: 'skip' | 'update' | 'error';
	validate_only?: boolean;
}

/**
 * Bulk update operation
 */
export interface BulkUpdateOperation {
	field: string;
	value: unknown;
	condition?: {
		field: string;
		operator: 'equals' | 'contains' | 'in';
		value: unknown;
	};
}

/**
 * Presigned upload URL response
 */
export interface UploadUrlResponse {
	upload_url: string;
	upload_method?: 'PUT';
	file_key: string;
	expires_at: string;
}

type ApiJobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'partial_failure';
type ApiJobType =
	| 'users/import'
	| 'users/bulk-update'
	| 'reports/generate'
	| 'organizations/bulk-members';

const JOB_TYPE_TO_API: Record<JobType, ApiJobType> = {
	users_import: 'users/import',
	users_bulk_update: 'users/bulk-update',
	report_generation: 'reports/generate',
	org_bulk_members: 'organizations/bulk-members'
};

const JOB_TYPE_FROM_API: Record<ApiJobType, JobType> = {
	'users/import': 'users_import',
	'users/bulk-update': 'users_bulk_update',
	'reports/generate': 'report_generation',
	'organizations/bulk-members': 'org_bulk_members'
};

function normalizeJobStatus(status: ApiJobStatus | JobStatus | string | undefined): JobStatus {
	switch (status) {
		case 'processing':
			return 'running';
		case 'partial_failure':
			return 'partial_failure';
		case 'pending':
		case 'running':
		case 'completed':
		case 'failed':
		case 'cancelled':
			return status;
		default:
			return 'pending';
	}
}

function normalizeJobType(type: ApiJobType | JobType | string | undefined): JobType {
	if (!type) {
		return 'report_generation';
	}
	return JOB_TYPE_FROM_API[type as ApiJobType] || (type as JobType);
}

function normalizeProgress(raw: Record<string, unknown> | undefined, status: JobStatus): JobProgress | undefined {
	if (!raw) {
		return undefined;
	}

	const total = Number(raw.total ?? 0);
	const processed = Number(raw.processed ?? 0);
	const percentage =
		typeof raw.percentage === 'number'
			? raw.percentage
			: total > 0
				? Math.round((processed / total) * 100)
				: status === 'completed' || status === 'partial_failure'
					? 100
					: 0;

	return {
		total,
		processed,
		percentage: Math.min(100, Math.max(0, percentage)),
		current_item: typeof raw.current_item === 'string' ? raw.current_item : undefined,
		stage: typeof raw.stage === 'string' ? raw.stage : undefined,
		succeeded: typeof raw.succeeded === 'number' ? raw.succeeded : undefined,
		failed: typeof raw.failed === 'number' ? raw.failed : undefined,
		skipped: typeof raw.skipped === 'number' ? raw.skipped : undefined
	};
}

function normalizeResult(raw: Record<string, unknown> | undefined): JobResult | undefined {
	if (!raw) {
		return undefined;
	}

	const rawSummary = (raw.summary as Record<string, unknown> | undefined) ?? {};
	const rawFailures = Array.isArray(raw.failures) ? raw.failures : [];
	const rawLogs = Array.isArray(raw.logs) ? raw.logs : [];

	return {
		summary: {
			success_count: Number(rawSummary.success_count ?? rawSummary.succeeded ?? 0),
			failure_count: Number(rawSummary.failure_count ?? rawSummary.failed ?? 0),
			skipped_count: Number(rawSummary.skipped_count ?? rawSummary.skipped ?? 0),
			warnings: Array.isArray(rawSummary.warnings)
				? rawSummary.warnings.filter((entry): entry is string => typeof entry === 'string')
				: []
		},
		failures: rawFailures.map((failure) => {
			const value = failure as Record<string, unknown>;
			return {
				line: typeof value.row === 'number' ? value.row : typeof value.line === 'number' ? value.line : undefined,
				item: typeof value.email === 'string' ? value.email : typeof value.item === 'string' ? value.item : undefined,
				error:
					(typeof value.message === 'string' && value.message) ||
					(typeof value.error === 'string' && value.error) ||
					'Unknown error',
				code: typeof value.error_code === 'string' ? value.error_code : typeof value.code === 'string' ? value.code : undefined
			};
		}),
		logs: rawLogs.map((entry) => {
			const value = entry as Record<string, unknown>;
			return {
				timestamp: typeof value.timestamp === 'string' ? value.timestamp : '',
				level:
					value.level === 'warn' || value.level === 'error' || value.level === 'info'
						? value.level
						: 'info',
				code: typeof value.code === 'string' ? value.code : 'log',
				message: typeof value.message === 'string' ? value.message : '',
				row: typeof value.row === 'number' ? value.row : undefined,
				email: typeof value.email === 'string' ? value.email : undefined
			};
		}),
		artifact_id: typeof raw.artifact_id === 'string' ? raw.artifact_id : undefined,
		available_formats: Array.isArray(raw.available_formats)
			? raw.available_formats.filter(
					(format): format is 'json' | 'csv' => format === 'json' || format === 'csv'
				)
			: undefined,
		manifest_url: typeof raw.manifest_url === 'string' ? raw.manifest_url : undefined,
		download_url: typeof raw.download_url === 'string' ? raw.download_url : undefined
	};
}

function normalizeJob(raw: Record<string, unknown>): Job {
	const status = normalizeJobStatus((raw.status as string | undefined) ?? 'pending');
	return {
		id: String(raw.id ?? raw.job_id ?? ''),
		tenant_id: String(raw.tenant_id ?? ''),
		type: normalizeJobType((raw.type as string | undefined) ?? (raw.job_type as string | undefined)),
		status,
		progress: normalizeProgress(raw.progress as Record<string, unknown> | undefined, status),
		result: normalizeResult(raw.result as Record<string, unknown> | undefined),
		created_by: String(raw.created_by ?? 'system'),
		created_at: String(raw.created_at ?? ''),
		started_at: typeof raw.started_at === 'string' ? raw.started_at : undefined,
		completed_at: typeof raw.completed_at === 'string' ? raw.completed_at : undefined,
		parameters: (raw.parameters as Record<string, unknown> | undefined) ?? undefined
	};
}

/**
 * List response with cursor pagination
 */
export interface ListResponse<T> {
	data: T[];
	has_more: boolean;
	next_cursor?: string;
}

/**
 * Admin Jobs API
 */
export const adminJobsAPI = {
	/**
	 * List all jobs
	 */
	async list(params?: {
		limit?: number;
		cursor?: string;
		status?: JobStatus;
		type?: JobType;
	}): Promise<ListResponse<Job>> {
		const searchParams = new URLSearchParams();
		if (params?.limit) searchParams.set('limit', params.limit.toString());
		if (params?.cursor) searchParams.set('cursor', params.cursor);

		const filters: string[] = [];
		if (params?.status) filters.push(`status=${params.status === 'running' ? 'processing' : params.status}`);
		if (params?.type) filters.push(`job_type=${JOB_TYPE_TO_API[params.type]}`);
		if (filters.length > 0) searchParams.set('filter', filters.join(','));

		const url = `${API_BASE_URL}/api/admin/jobs${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await adminFetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list jobs');
		}

		const payload = (await response.json()) as {
			data?: Record<string, unknown>[];
			pagination?: { has_more?: boolean; next_cursor?: string };
		};

		return {
			data: Array.isArray(payload.data) ? payload.data.map(normalizeJob) : [],
			has_more: payload.pagination?.has_more ?? false,
			next_cursor: payload.pagination?.next_cursor
		};
	},

	/**
	 * Get job status
	 */
	async get(jobId: string): Promise<Job> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/${jobId}`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get job');
		}

		return normalizeJob((await response.json()) as Record<string, unknown>);
	},

	/**
	 * Get job result
	 */
	async getResult(jobId: string): Promise<JobResult> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/${jobId}/result`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get job result');
		}

		return normalizeResult((await response.json()) as Record<string, unknown>) as JobResult;
	},

	/**
	 * Get presigned upload URL for user import
	 */
	async getUploadUrl(
		filename: string,
		contentType = 'text/csv',
		sizeBytes = 0
	): Promise<UploadUrlResponse> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/users/import/upload-url`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				filename,
				content_type: contentType,
				size_bytes: sizeBytes
			})
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get upload URL');
		}

		return response.json();
	},

	async uploadImportFile(uploadUrl: string, file: File): Promise<{ file_key: string }> {
		const response = await adminFetch(uploadUrl, {
			method: 'PUT',
			body: file,
			headers: {
				'Content-Type': 'text/csv'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to upload import file');
		}

		return response.json();
	},

	/**
	 * Create user import job
	 */
	async createUserImport(params: { file_key: string; options?: UserImportOptions }): Promise<Job> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/users/import`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(params)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create import job');
		}

		return normalizeJob((await response.json()) as Record<string, unknown>);
	},

	/**
	 * Create bulk user update job
	 */
	async createBulkUpdate(params: {
		operations: BulkUpdateOperation[];
		dry_run?: boolean;
	}): Promise<Job> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/users/bulk-update`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(params)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create bulk update job');
		}

		return normalizeJob((await response.json()) as Record<string, unknown>);
	},

	/**
	 * Create report generation job
	 */
	async createReport(params: {
		type: ReportType;
		parameters?: {
			from?: string;
			to?: string;
			user_ids?: string[];
			client_ids?: string[];
		};
	}): Promise<Job> {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/jobs/reports/generate`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(params)
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create report job');
		}

		return normalizeJob((await response.json()) as Record<string, unknown>);
	},

	/**
	 * Create organization bulk members job
	 */
	async createOrgBulkMembers(
		organizationId: string,
		params: {
			action: 'add' | 'remove';
			user_ids: string[];
		}
	): Promise<Job> {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/jobs/organizations/${organizationId}/bulk-members`,
			{
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(params)
			}
		);

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to create org bulk members job');
		}

		return normalizeJob((await response.json()) as Record<string, unknown>);
	}
};

/**
 * Get job status color
 */
export function getJobStatusColor(status: JobStatus): string {
	switch (status) {
		case 'pending':
			return '#6b7280';
		case 'running':
			return '#3b82f6';
		case 'completed':
			return '#22c55e';
		case 'partial_failure':
			return '#f59e0b';
		case 'failed':
			return '#ef4444';
		case 'cancelled':
			return '#9ca3af';
		default:
			return '#6b7280';
	}
}

export function getJobStatusDisplayName(status: JobStatus): string {
	switch (status) {
		case 'pending':
			return 'Pending';
		case 'running':
			return 'Running';
		case 'completed':
			return 'Completed';
		case 'partial_failure':
			return 'Partial Failure';
		case 'failed':
			return 'Failed';
		case 'cancelled':
			return 'Cancelled';
		default:
			return 'Unknown';
	}
}

/**
 * Get job type display name
 */
export function getJobTypeDisplayName(type: JobType): string {
	const names: Record<JobType, string> = {
		users_import: 'User Import',
		users_bulk_update: 'Bulk User Update',
		report_generation: 'Report Generation',
		org_bulk_members: 'Organization Bulk Members'
	};
	return names[type] || 'Unknown Job Type';
}

/**
 * Get report type display name
 */
export function getReportTypeDisplayName(type: ReportType): string {
	const names: Record<ReportType, string> = {
		user_activity: 'User Activity Report',
		access_summary: 'Access Summary Report',
		compliance_audit: 'Compliance Audit Report',
		security_events: 'Security Events Report'
	};
	return names[type] || 'Unknown Report Type';
}

/**
 * Format job duration
 * Handles clock skew between server and client by clamping to 0
 */
export function formatJobDuration(startedAt?: string, completedAt?: string): string {
	if (!startedAt) return '-';

	const start = new Date(startedAt);
	if (isNaN(start.getTime())) return '-';

	const end = completedAt ? new Date(completedAt) : new Date();
	if (isNaN(end.getTime())) return '-';

	// Prevent negative duration due to clock skew
	const durationMs = Math.max(0, end.getTime() - start.getTime());

	if (durationMs < 1000) return `${durationMs}ms`;
	if (durationMs < 60000) return `${Math.round(durationMs / 1000)}s`;
	if (durationMs < 3600000) return `${Math.round(durationMs / 60000)}m`;
	return `${Math.round(durationMs / 3600000)}h`;
}
