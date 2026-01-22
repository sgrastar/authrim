/**
 * Admin Access Trace API Client
 *
 * Provides methods for viewing permission check audit logs:
 * - List and filter access trace entries
 * - View detailed entry information
 * - Get statistics and timeline data
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

// =============================================================================
// Types
// =============================================================================

/**
 * Parsed permission structure
 */
export interface ParsedPermission {
	resource_type?: string;
	resource_id?: string;
	action?: string;
	scope?: string;
}

/**
 * Access trace entry (permission check audit log)
 */
export interface AccessTraceEntry {
	id: string;
	subject_id: string;
	permission: string;
	permission_parsed?: ParsedPermission;
	allowed: boolean;
	resolved_via: string[];
	final_decision: string;
	reason?: string;
	api_key_id?: string;
	client_id?: string;
	checked_at: number;
}

/**
 * Access trace statistics
 */
export interface AccessTraceStats {
	period: string;
	total: number;
	allowed: number;
	denied: number;
	allow_rate: number;
	top_denied_permissions: Array<{ permission: string; count: number }>;
	top_denied_subjects: Array<{ subject_id: string; count: number }>;
	resolution_distribution: Array<{ resolved_via: string; count: number }>;
}

/**
 * Timeline data point
 */
export interface TimelineDataPoint {
	timestamp: number;
	total: number;
	allowed: number;
	denied: number;
}

/**
 * Timeline response
 */
export interface TimelineResponse {
	period: string;
	granularity: number;
	data: TimelineDataPoint[];
}

/**
 * Pagination info
 */
export interface PaginationInfo {
	page: number;
	limit: number;
	total: number;
	total_pages: number;
}

// =============================================================================
// API Client
// =============================================================================

/**
 * Admin Access Trace API client
 */
export const adminAccessTraceAPI = {
	/**
	 * List access trace entries
	 */
	async listEntries(params?: {
		subject_id?: string;
		permission?: string;
		allowed?: boolean;
		final_decision?: string;
		start_time?: number;
		end_time?: number;
		page?: number;
		limit?: number;
	}): Promise<{ entries: AccessTraceEntry[]; pagination: PaginationInfo }> {
		const searchParams = new URLSearchParams();
		if (params?.subject_id) searchParams.set('subject_id', params.subject_id);
		if (params?.permission) searchParams.set('permission', params.permission);
		if (params?.allowed !== undefined) searchParams.set('allowed', String(params.allowed));
		if (params?.final_decision) searchParams.set('final_decision', params.final_decision);
		if (params?.start_time) searchParams.set('start_time', params.start_time.toString());
		if (params?.end_time) searchParams.set('end_time', params.end_time.toString());
		if (params?.page) searchParams.set('page', params.page.toString());
		if (params?.limit) searchParams.set('limit', params.limit.toString());

		const response = await fetch(`${API_BASE_URL}/api/admin/access-trace?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to list access trace entries');
		}

		return response.json();
	},

	/**
	 * Get access trace entry by ID
	 */
	async getEntry(id: string): Promise<{ entry: AccessTraceEntry }> {
		const response = await fetch(`${API_BASE_URL}/api/admin/access-trace/${id}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get access trace entry');
		}

		return response.json();
	},

	/**
	 * Get access trace statistics
	 */
	async getStats(period?: '1h' | '6h' | '24h' | '7d' | '30d'): Promise<AccessTraceStats> {
		const searchParams = new URLSearchParams();
		if (period) searchParams.set('period', period);

		const response = await fetch(`${API_BASE_URL}/api/admin/access-trace/stats?${searchParams}`, {
			method: 'GET',
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get access trace stats');
		}

		return response.json();
	},

	/**
	 * Get timeline data for charts
	 */
	async getTimeline(
		period?: '1h' | '6h' | '24h' | '7d' | '30d',
		granularity?: 'minute' | 'hour'
	): Promise<TimelineResponse> {
		const searchParams = new URLSearchParams();
		if (period) searchParams.set('period', period);
		if (granularity) searchParams.set('granularity', granularity);

		const response = await fetch(
			`${API_BASE_URL}/api/admin/access-trace/timeline?${searchParams}`,
			{
				method: 'GET',
				credentials: 'include'
			}
		);

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(error.error_description || 'Failed to get access trace timeline');
		}

		return response.json();
	}
};

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get badge color for decision
 */
export function getDecisionColor(allowed: boolean): string {
	return allowed ? 'success' : 'danger';
}

/**
 * Get decision label
 */
export function getDecisionLabel(allowed: boolean): string {
	return allowed ? 'Allowed' : 'Denied';
}

/**
 * Format resolved_via for display
 */
export function formatResolvedVia(resolvedVia: string[]): string {
	if (!resolvedVia || resolvedVia.length === 0) return 'Unknown';

	const labels: Record<string, string> = {
		role: 'Role',
		rebac: 'ReBAC',
		policy: 'Policy',
		attribute: 'ABAC',
		resource_permission: 'Resource Permission',
		default: 'Default'
	};

	return resolvedVia.map((r) => labels[r] || r).join(', ');
}

/**
 * Format permission for display
 */
export function formatPermission(permission: string, parsed?: ParsedPermission): string {
	if (parsed) {
		const parts: string[] = [];
		if (parsed.resource_type) parts.push(parsed.resource_type);
		if (parsed.resource_id) parts.push(`:${parsed.resource_id}`);
		if (parsed.action) parts.push(`#${parsed.action}`);
		if (parsed.scope) parts.push(`@${parsed.scope}`);
		if (parts.length > 0) return parts.join('');
	}
	return permission;
}

/**
 * Get period label
 */
export function getPeriodLabel(period: string): string {
	const labels: Record<string, string> = {
		'1h': 'Last hour',
		'6h': 'Last 6 hours',
		'24h': 'Last 24 hours',
		'7d': 'Last 7 days',
		'30d': 'Last 30 days'
	};
	return labels[period] || period;
}

/**
 * Format timestamp for display
 */
export function formatTimestamp(timestamp: number): string {
	return new Date(timestamp * 1000).toLocaleString();
}
