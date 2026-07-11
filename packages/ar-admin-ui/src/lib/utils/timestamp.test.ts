import { describe, expect, it } from 'vitest';
import { normalizeTimestampMs } from './timestamp';

describe('normalizeTimestampMs', () => {
	it('normalizes seconds, milliseconds, microseconds, and nanoseconds to milliseconds', () => {
		const milliseconds = Date.UTC(2026, 6, 10, 10, 35, 4);

		expect(normalizeTimestampMs(Math.floor(milliseconds / 1000))).toBe(milliseconds);
		expect(normalizeTimestampMs(milliseconds)).toBe(milliseconds);
		expect(normalizeTimestampMs(milliseconds * 1000)).toBe(milliseconds);
		expect(normalizeTimestampMs(milliseconds * 1_000_000)).toBe(milliseconds);
	});

	it('keeps invalid timestamps invalid', () => {
		expect(normalizeTimestampMs(Number.NaN)).toBeNaN();
	});
});
