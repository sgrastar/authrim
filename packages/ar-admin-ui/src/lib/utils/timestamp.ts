/** Convert epoch timestamps stored in seconds, milliseconds, microseconds, or nanoseconds to ms. */
export function normalizeTimestampMs(timestamp: number): number {
	if (!Number.isFinite(timestamp)) return Number.NaN;

	const absolute = Math.abs(timestamp);
	if (absolute < 100_000_000_000) return timestamp * 1000;
	if (absolute < 100_000_000_000_000) return timestamp;
	if (absolute < 100_000_000_000_000_000) return timestamp / 1000;
	return timestamp / 1_000_000;
}
