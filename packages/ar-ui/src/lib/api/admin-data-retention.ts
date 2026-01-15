/**
 * Admin Data Retention API Client
 *
 * Provides methods for managing data retention policies and viewing retention statistics.
 */

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

/**
 * Retention category information
 */
export interface RetentionCategory {
	category: string;
	retention_days: number;
	total_records: number;
	records_pending_deletion: number;
	oldest_record_date: string | null;
	next_cleanup_date: string | null;
	last_cleanup_date: string | null;
	records_deleted_last_30_days: number;
}

/**
 * Data retention policy status
 */
export interface DataRetentionPolicy {
	enabled: boolean;
	default_retention_days: number;
	gdpr_compliant: boolean;
	next_scheduled_cleanup: string | null;
	last_cleanup: string | null;
}

/**
 * Storage statistics
 */
export interface StorageStats {
	total_records: number;
	records_pending_deletion: number;
	records_deleted_last_30_days: number;
	pending_erasure_requests: number;
	estimated_savings_mb: number;
}

/**
 * Full data retention status response
 */
export interface DataRetentionStatus {
	policy: DataRetentionPolicy;
	categories: RetentionCategory[];
	storage: StorageStats;
	last_updated: string;
}

/**
 * Cleanup estimate for a category
 */
export interface CleanupEstimate {
	category: string;
	current_retention_days: number;
	proposed_retention_days: number;
	records_to_delete: number;
	oldest_record_date: string | null;
	next_run_at: string | null;
	estimated_deletion_at: string | null;
}

/**
 * Cleanup run status
 */
export interface CleanupRun {
	run_id: string;
	status: 'pending' | 'running' | 'completed' | 'failed';
	progress?: {
		current: number;
		total: number;
	};
	deleted_count?: number;
	started_at: string;
	completed_at?: string;
	error?: string;
}

/**
 * Get human-readable category name
 */
export function getCategoryDisplayName(category: string): string {
	const names: Record<string, string> = {
		audit_logs: 'Audit Logs',
		session_data: 'Session Data',
		tombstones: 'Deletion Records (Tombstones)',
		auth_codes: 'Authorization Codes',
		refresh_tokens: 'Refresh Tokens',
		access_tokens: 'Access Tokens'
	};
	return names[category] || category.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Get category description
 */
export function getCategoryDescription(category: string): string {
	const descriptions: Record<string, string> = {
		audit_logs: 'Security and activity logs for compliance tracking',
		session_data: 'User session information and authentication state',
		tombstones: 'Records of deleted data for GDPR compliance (deletion proof)',
		auth_codes: 'OAuth authorization codes (short-lived)',
		refresh_tokens: 'OAuth refresh tokens for session renewal',
		access_tokens: 'OAuth access tokens for API authentication'
	};
	return descriptions[category] || 'Data retention category';
}

export const adminDataRetentionAPI = {
	/**
	 * Get data retention status and statistics
	 */
	async getStatus(): Promise<DataRetentionStatus> {
		const response = await fetch(`${API_BASE_URL}/api/admin/data-retention/status`, {
			credentials: 'include'
		});

		if (!response.ok) {
			const error = await response.json().catch(() => ({}));
			throw new Error(
				error.error_description || error.message || 'Failed to fetch data retention status'
			);
		}

		const data = await response.json();

		// Transform backend response to our frontend format
		return {
			policy: {
				enabled: data.policy?.enabled ?? false,
				default_retention_days: data.policy?.default_retention_days ?? 365,
				gdpr_compliant: data.gdpr_compliant ?? false,
				next_scheduled_cleanup: data.next_scheduled_cleanup ?? null,
				last_cleanup: data.last_cleanup ?? null
			},
			categories: (data.categories || []).map(
				(c: {
					category: string;
					retention_days: number;
					total_records?: number;
					records_pending_deletion?: number;
					oldest_record_date?: string;
					next_cleanup_date?: string;
					last_cleanup_date?: string;
					records_deleted_last_30_days?: number;
				}) => ({
					category: c.category,
					retention_days: c.retention_days,
					total_records: c.total_records ?? 0,
					records_pending_deletion: c.records_pending_deletion ?? 0,
					oldest_record_date: c.oldest_record_date ?? null,
					next_cleanup_date: c.next_cleanup_date ?? null,
					last_cleanup_date: c.last_cleanup_date ?? null,
					records_deleted_last_30_days: c.records_deleted_last_30_days ?? 0
				})
			),
			storage: {
				total_records: data.storage?.total_records ?? 0,
				records_pending_deletion: data.storage?.records_pending_deletion ?? 0,
				records_deleted_last_30_days: data.storage?.records_deleted_last_30_days ?? 0,
				pending_erasure_requests: data.storage?.pending_erasure_requests ?? 0,
				estimated_savings_mb: data.storage?.estimated_savings_mb ?? 0
			},
			last_updated: data.last_updated ?? new Date().toISOString()
		};
	}

	// Future P3 methods (when backend is ready):
	// async updatePolicy(policy: Partial<DataRetentionPolicy>): Promise<DataRetentionPolicy>
	// async getEstimate(category?: string, days?: number): Promise<CleanupEstimate[]>
	// async runCleanup(categories?: string[], idempotencyKey?: string): Promise<CleanupRun>
	// async getCleanupStatus(runId: string): Promise<CleanupRun>
};
