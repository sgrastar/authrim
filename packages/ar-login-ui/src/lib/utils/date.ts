/**
 * Date formatting utilities
 */

/**
 * Check if a date string is valid
 */
function isValidDate(date: Date): boolean {
	return !isNaN(date.getTime());
}

/**
 * Format a date string to locale string
 * Returns fallback string for invalid dates
 */
export function formatDate(dateStr: string): string {
	if (!dateStr) return '-';
	const date = new Date(dateStr);
	if (!isValidDate(date)) return '-';
	return date.toLocaleString();
}

/**
 * Format a date string to relative time (e.g., "2 hours ago")
 * Returns fallback string for invalid dates
 */
export function formatRelativeTime(dateStr: string): string {
	if (!dateStr) return '-';
	const date = new Date(dateStr);
	if (!isValidDate(date)) return '-';

	const now = new Date();
	const diffMs = now.getTime() - date.getTime();

	// Handle future dates (clock skew)
	if (diffMs < 0) return formatDate(dateStr);

	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffSecs < 60) return 'just now';
	if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
	if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
	if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

	return formatDate(dateStr);
}
