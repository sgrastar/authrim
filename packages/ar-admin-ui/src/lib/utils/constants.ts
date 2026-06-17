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
	pending: 'var(--color-text-muted)',
	running: 'var(--color-info)',
	in_progress: 'var(--color-info)',
	generating: 'var(--color-info)',
	completed: 'var(--color-success)',
	success: 'var(--color-success)',
	failed: 'var(--color-danger)',
	error: 'var(--color-danger)',
	cancelled: 'var(--color-text-subtle)',
	dismissed: 'var(--color-text-subtle)',

	// Severity levels
	critical: 'var(--color-danger)',
	high: 'var(--orange)',
	medium: 'var(--color-warning)',
	low: 'var(--color-success)',
	info: 'var(--color-info)',

	// Alert statuses
	open: 'var(--color-danger)',
	acknowledged: 'var(--color-warning)',
	resolved: 'var(--color-success)',

	// Default
	default: 'var(--color-text-muted)'
} as const;

/**
 * Get color for a given status
 */
export function getStatusColor(status: string): string {
	return STATUS_COLORS[status as keyof typeof STATUS_COLORS] || STATUS_COLORS.default;
}
