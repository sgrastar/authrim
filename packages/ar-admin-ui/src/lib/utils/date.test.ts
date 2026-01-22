import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { formatDate, formatRelativeTime } from './date';

describe('date utilities', () => {
	describe('formatDate', () => {
		it('returns "-" for empty string', () => {
			expect(formatDate('')).toBe('-');
		});

		it('returns "-" for invalid date string', () => {
			expect(formatDate('not-a-date')).toBe('-');
			expect(formatDate('invalid')).toBe('-');
		});

		it('formats valid date string to locale string', () => {
			const result = formatDate('2024-01-15T10:30:00Z');
			// Should be a non-empty string that's not the fallback
			expect(result).not.toBe('-');
			expect(result.length).toBeGreaterThan(0);
		});

		it('handles ISO date format', () => {
			const result = formatDate('2024-06-01T14:00:00.000Z');
			expect(result).not.toBe('-');
		});
	});

	describe('formatRelativeTime', () => {
		beforeEach(() => {
			// Mock current time to 2024-01-15T12:00:00Z
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2024-01-15T12:00:00Z'));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('returns "-" for empty string', () => {
			expect(formatRelativeTime('')).toBe('-');
		});

		it('returns "-" for invalid date string', () => {
			expect(formatRelativeTime('not-a-date')).toBe('-');
		});

		it('returns "just now" for dates less than 60 seconds ago', () => {
			const thirtySecsAgo = new Date('2024-01-15T11:59:30Z').toISOString();
			expect(formatRelativeTime(thirtySecsAgo)).toBe('just now');
		});

		it('returns minutes ago for dates less than 60 minutes ago', () => {
			const fiveMinsAgo = new Date('2024-01-15T11:55:00Z').toISOString();
			expect(formatRelativeTime(fiveMinsAgo)).toBe('5 minutes ago');

			const oneMinAgo = new Date('2024-01-15T11:59:00Z').toISOString();
			expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago');
		});

		it('returns hours ago for dates less than 24 hours ago', () => {
			const threeHoursAgo = new Date('2024-01-15T09:00:00Z').toISOString();
			expect(formatRelativeTime(threeHoursAgo)).toBe('3 hours ago');

			const oneHourAgo = new Date('2024-01-15T11:00:00Z').toISOString();
			expect(formatRelativeTime(oneHourAgo)).toBe('1 hour ago');
		});

		it('returns days ago for dates less than 7 days ago', () => {
			const twoDaysAgo = new Date('2024-01-13T12:00:00Z').toISOString();
			expect(formatRelativeTime(twoDaysAgo)).toBe('2 days ago');

			const oneDayAgo = new Date('2024-01-14T12:00:00Z').toISOString();
			expect(formatRelativeTime(oneDayAgo)).toBe('1 day ago');
		});

		it('returns formatted date for dates more than 7 days ago', () => {
			const tenDaysAgo = new Date('2024-01-05T12:00:00Z').toISOString();
			const result = formatRelativeTime(tenDaysAgo);
			// Should fall back to formatDate (not the fallback "-")
			expect(result).not.toBe('-');
			expect(result).not.toContain('days ago');
		});

		it('handles future dates (clock skew) by returning formatted date', () => {
			const futureDate = new Date('2024-01-15T13:00:00Z').toISOString();
			const result = formatRelativeTime(futureDate);
			// Should fall back to formatDate for future dates
			expect(result).not.toBe('-');
			expect(result).not.toContain('ago');
		});
	});
});
