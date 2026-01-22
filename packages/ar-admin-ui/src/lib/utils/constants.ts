/**
 * UI constants
 */

/**
 * Default page sizes for list views
 */
export const DEFAULT_PAGE_SIZE = 50;
export const SMALL_PAGE_SIZE = 10;
export const LARGE_PAGE_SIZE = 100;

/**
 * Polling intervals (in milliseconds)
 */
export const JOB_POLLING_INTERVAL = 10000; // 10 seconds

/**
 * Common status colors for UI consistency
 */
export const STATUS_COLORS = {
	// Generic statuses
	pending: '#6b7280',
	running: '#3b82f6',
	in_progress: '#3b82f6',
	generating: '#3b82f6',
	completed: '#22c55e',
	success: '#22c55e',
	failed: '#ef4444',
	error: '#ef4444',
	cancelled: '#9ca3af',
	dismissed: '#9ca3af',

	// Severity levels
	critical: '#dc2626',
	high: '#ea580c',
	medium: '#d97706',
	low: '#65a30d',
	info: '#0284c7',

	// Alert statuses
	open: '#ef4444',
	acknowledged: '#f59e0b',
	resolved: '#22c55e',

	// Default
	default: '#6b7280'
} as const;

/**
 * Get color for a given status
 */
export function getStatusColor(status: string): string {
	return STATUS_COLORS[status as keyof typeof STATUS_COLORS] || STATUS_COLORS.default;
}
