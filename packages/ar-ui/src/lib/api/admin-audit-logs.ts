/**
 * Admin Audit Logs API Client
 *
 * Provides API calls for audit log viewing:
 * - List audit logs with filtering and pagination
 * - Get audit log details
 */

// API Base URL - empty string for same-origin, or full URL for cross-origin
const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

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
 * Audit log entry
 */
export interface AuditLogEntry {
	id: string;
	userId: string | null;
	action: string;
	resourceType: string | null;
	resourceId: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

/**
 * Audit log list response
 */
export interface AuditLogListResponse {
	entries: AuditLogEntry[];
	pagination: Pagination;
}

/**
 * Audit log list parameters
 */
export interface AuditLogListParams {
	page?: number;
	limit?: number;
	user_id?: string;
	action?: string;
	resource_type?: string;
	resource_id?: string;
	start_date?: string;
	end_date?: string;
}

/**
 * Common action types for filtering
 */
export const AUDIT_ACTION_TYPES = [
	// User actions
	{ value: 'user.created', label: 'User Created' },
	{ value: 'user.updated', label: 'User Updated' },
	{ value: 'user.deleted', label: 'User Deleted' },
	{ value: 'user.suspend', label: 'User Suspended' },
	{ value: 'user.lock', label: 'User Locked' },
	{ value: 'user.activate', label: 'User Activated' },
	// Client actions
	{ value: 'client.created', label: 'Client Created' },
	{ value: 'client.updated', label: 'Client Updated' },
	{ value: 'client.deleted', label: 'Client Deleted' },
	// Session actions
	{ value: 'session.created', label: 'Session Created' },
	{ value: 'session.revoked', label: 'Session Revoked' },
	// Security actions
	{ value: 'signing_keys.rotate', label: 'Signing Keys Rotated' },
	{ value: 'signing_keys.rotate.emergency', label: 'Emergency Key Rotation' }
] as const;

/**
 * Admin Audit Logs API
 */
export const adminAuditLogsAPI = {
	/**
	 * List audit logs with filtering and pagination
	 * GET /api/admin/audit-logs
	 */
	async list(params?: AuditLogListParams): Promise<AuditLogListResponse> {
		const searchParams = new URLSearchParams();

		if (params?.page) searchParams.set('page', String(params.page));
		if (params?.limit) searchParams.set('limit', String(params.limit));
		if (params?.user_id) searchParams.set('user_id', params.user_id);
		if (params?.action) searchParams.set('action', params.action);
		if (params?.resource_type) searchParams.set('resource_type', params.resource_type);
		if (params?.resource_id) searchParams.set('resource_id', params.resource_id);
		if (params?.start_date) searchParams.set('start_date', params.start_date);
		if (params?.end_date) searchParams.set('end_date', params.end_date);

		const queryString = searchParams.toString();
		const url = `${API_BASE_URL}/api/admin/audit-logs${queryString ? `?${queryString}` : ''}`;

		const response = await fetch(url, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to fetch audit logs');
		}

		return response.json();
	},

	/**
	 * Get audit log entry details
	 * GET /api/admin/audit-logs/:id
	 *
	 * Note: Backend returns the entry object directly (not wrapped in { entry: ... })
	 */
	async get(id: string): Promise<AuditLogEntry> {
		const response = await fetch(`${API_BASE_URL}/api/admin/audit-logs/${id}`, {
			credentials: 'include'
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Audit log entry not found');
			}
			const error = await response.json().catch(() => ({ error: 'unknown_error' }));
			throw new Error(error.error_description || error.error || 'Failed to fetch audit log');
		}

		// Backend returns entry directly, not wrapped in { entry: ... }
		return response.json();
	}
};
