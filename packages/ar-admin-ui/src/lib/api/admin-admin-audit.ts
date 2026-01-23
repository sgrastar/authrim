/**
 * Admin Audit Log API Client
 *
 * Provides API calls for viewing Admin operation audit logs (stored in DB_ADMIN).
 * These are separate from general audit logs (EndUser operations).
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Admin audit log entry
 */
export interface AdminAuditLogEntry {
	id: string;
	tenant_id: string;
	admin_user_id: string | null;
	admin_email: string | null;
	admin_user_name?: string | null;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	result: 'success' | 'failure';
	severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
	ip_address: string | null;
	user_agent: string | null;
	request_id: string | null;
	before: Record<string, unknown> | null;
	after: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	created_at: number;
}

/**
 * Admin audit log entry with enriched user info
 */
export interface AdminAuditLogEntryDetail extends AdminAuditLogEntry {
	admin_user: {
		id: string;
		email: string;
		name: string | null;
	} | null;
}

/**
 * Pagination info
 */
export interface Pagination {
	page: number;
	limit: number;
	total: number;
	totalPages: number;
}

/**
 * Admin audit log list response
 */
export interface AdminAuditLogListResponse {
	items: AdminAuditLogEntry[];
	total: number;
	page: number;
	limit: number;
	totalPages: number;
}

/**
 * Admin audit log list parameters
 */
export interface AdminAuditLogListParams {
	page?: number;
	limit?: number;
	admin_user_id?: string;
	action?: string;
	resource_type?: string;
	result?: 'success' | 'failure';
	severity?: 'debug' | 'info' | 'warn' | 'error' | 'critical';
	start_date?: string;
	end_date?: string;
}

/**
 * Actions list response
 */
export interface ActionsListResponse {
	items: string[];
	total: number;
}

/**
 * Resource types list response
 */
export interface ResourceTypesListResponse {
	items: string[];
	total: number;
}

/**
 * Audit log statistics
 */
export interface AdminAuditLogStats {
	total_entries: number;
	recent_entries: number;
	time_range_days: number;
	result_breakdown: Record<string, number>;
	severity_breakdown: Record<string, number>;
	top_actions: Array<{ action: string; count: number }>;
	most_active_admins: Array<{
		admin_user_id: string;
		admin_email: string;
		action_count: number;
	}>;
}

/**
 * Admin Audit Log API
 */
export const adminAdminAuditAPI = {
	/**
	 * List admin audit log entries with pagination and filtering
	 * GET /api/admin/admin-audit-log
	 */
	async list(params?: AdminAuditLogListParams): Promise<AdminAuditLogListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.admin_user_id) searchParams.set('admin_user_id', params.admin_user_id);
		if (params?.action) searchParams.set('action', params.action);
		if (params?.resource_type) searchParams.set('resource_type', params.resource_type);
		if (params?.result) searchParams.set('result', params.result);
		if (params?.severity) searchParams.set('severity', params.severity);
		if (params?.start_date) searchParams.set('start_date', params.start_date);
		if (params?.end_date) searchParams.set('end_date', params.end_date);

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/admin-audit-log${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch admin audit logs');
		}

		return response.json();
	},

	/**
	 * Get admin audit log entry details
	 * GET /api/admin/admin-audit-log/:id
	 */
	async get(id: string): Promise<AdminAuditLogEntryDetail> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-audit-log/${encodeURIComponent(id)}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Audit log entry not found');
			}
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch audit log entry');
		}

		return response.json();
	},

	/**
	 * List all unique action types
	 * GET /api/admin/admin-audit-log/actions/list
	 */
	async listActions(): Promise<ActionsListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admin-audit-log/actions/list`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch actions');
		}

		return response.json();
	},

	/**
	 * List all unique resource types
	 * GET /api/admin/admin-audit-log/resource-types/list
	 */
	async listResourceTypes(): Promise<ResourceTypesListResponse> {
		const response = await fetch(`${API_BASE_URL}/api/admin/admin-audit-log/resource-types/list`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch resource types');
		}

		return response.json();
	},

	/**
	 * Get audit log statistics
	 * GET /api/admin/admin-audit-log/stats/summary
	 */
	async getStats(days: number = 7): Promise<AdminAuditLogStats> {
		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-audit-log/stats/summary?days=${days}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch audit log stats');
		}

		return response.json();
	},

	/**
	 * Get audit log entries for a specific admin user
	 * GET /api/admin/admin-audit-log/user/:userId
	 */
	async getByUser(
		userId: string,
		page: number = 1,
		limit: number = 50
	): Promise<AdminAuditLogListResponse> {
		const params = new URLSearchParams({
			page: String(page),
			limit: String(limit)
		});

		const response = await fetch(
			`${API_BASE_URL}/api/admin/admin-audit-log/user/${encodeURIComponent(userId)}?${params}`,
			{
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to fetch user audit logs');
		}

		return response.json();
	}
};

/**
 * Get severity badge class
 */
export function getSeverityBadgeClass(severity: string): string {
	switch (severity) {
		case 'debug':
			return 'badge badge-neutral';
		case 'info':
			return 'badge badge-info';
		case 'warn':
			return 'badge badge-warning';
		case 'error':
			return 'badge badge-danger';
		case 'critical':
			return 'badge badge-danger badge-pulse';
		default:
			return 'badge badge-neutral';
	}
}

/**
 * Get result badge class
 */
export function getResultBadgeClass(result: string): string {
	switch (result) {
		case 'success':
			return 'badge badge-success';
		case 'failure':
			return 'badge badge-danger';
		default:
			return 'badge badge-neutral';
	}
}

/**
 * Format action for display
 */
export function formatAction(action: string): string {
	return action
		.split('.')
		.map((part) => part.replace(/_/g, ' '))
		.join(' → ')
		.replace(/\b\w/g, (l) => l.toUpperCase());
}
