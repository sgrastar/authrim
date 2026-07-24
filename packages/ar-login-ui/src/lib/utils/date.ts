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
 * Normalize Authrim API timestamps to milliseconds.
 * Account page APIs currently expose both repository timestamps in milliseconds
 * and compatibility fields in Unix seconds.
 */
export function normalizeTimestampToMillis(value: number | null | undefined): number | null {
	if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return value < 1_000_000_000_000 ? value * 1000 : value;
}

/**
 * Format a numeric timestamp that may be Unix seconds or milliseconds.
 */
export function formatTimestamp(value: number | null | undefined, locale?: string): string {
	const millis = normalizeTimestampToMillis(value);
	if (millis === null) return '-';
	const date = new Date(millis);
	if (!isValidDate(date)) return '-';
	return date.toLocaleString(locale?.replace('_', '-'));
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
