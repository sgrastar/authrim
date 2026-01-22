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
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Job progress info
 */
export interface JobProgress {
	processed: number;
	total: number;
	percentage: number;
	current_item?: string;
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

/**
 * Job result
 */
export interface JobResult {
	summary: JobResultSummary;
	failures: JobFailure[];
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
	file_key: string;
	expires_at: string;
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
		if (params?.status) filters.push(`status=${params.status}`);
		if (params?.type) filters.push(`job_type=${params.type}`);
		if (filters.length > 0) searchParams.set('filter', filters.join(','));

		const url = `${API_BASE_URL}/api/admin/jobs${searchParams.toString() ? '?' + searchParams.toString() : ''}`;

		const response = await fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to list jobs');
		}

		return response.json();
	},

	/**
	 * Get job status
	 */
	async get(jobId: string): Promise<Job> {
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/${jobId}`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get job');
		}

		return response.json();
	},

	/**
	 * Get job result
	 */
	async getResult(jobId: string): Promise<JobResult> {
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/${jobId}/result`, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			}
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get job result');
		}

		return response.json();
	},

	/**
	 * Get presigned upload URL for user import
	 */
	async getUploadUrl(filename: string): Promise<UploadUrlResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/users/import/upload-url`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ filename })
		});

		if (!response.ok) {
			throw await handleAPIError(response, 'Failed to get upload URL');
		}

		return response.json();
	},

	/**
	 * Create user import job
	 */
	async createUserImport(params: { file_key: string; options?: UserImportOptions }): Promise<Job> {
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/users/import`, {
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

		return response.json();
	},

	/**
	 * Create bulk user update job
	 */
	async createBulkUpdate(params: {
		operations: BulkUpdateOperation[];
		dry_run?: boolean;
	}): Promise<Job> {
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/users/bulk-update`, {
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

		return response.json();
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
		const response = await fetch(`${API_BASE_URL}/api/admin/jobs/reports/generate`, {
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

		return response.json();
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
		const response = await fetch(
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

		return response.json();
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
		case 'failed':
			return '#ef4444';
		case 'cancelled':
			return '#9ca3af';
		default:
			return '#6b7280';
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
