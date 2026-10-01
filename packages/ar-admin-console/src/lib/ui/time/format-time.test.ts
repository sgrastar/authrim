import { describe, expect, it } from 'vitest';
import { formatTime, toDate } from './format-time';

const instant = '2026-09-26T05:05:30Z';

describe('formatTime', () => {
	it('shows UTC with its label', () => {
		expect(formatTime(instant, { locale: 'ja', zone: 'utc' })?.text).toBe('2026/09/26 05:05 UTC');
		expect(formatTime(instant, { locale: 'en', zone: 'utc', seconds: true })?.text).toBe(
			'09/26/2026, 05:05:30 UTC'
		);
	});

	it('shows the local zone with its short name', () => {
		const tokyo = formatTime(instant, { locale: 'ja', zone: 'local', localTimeZone: 'Asia/Tokyo' });
		expect(tokyo).toMatchObject({ text: '2026/09/26 14:05 JST', zone: 'JST' });
	});

	it('changes the calendar day when the zone crosses midnight', () => {
		const late = '2026-09-26T20:00:00Z';
		expect(formatTime(late, { locale: 'ja', zone: 'utc', style: 'date' })?.text).toBe('2026/09/26');
		expect(
			formatTime(late, { locale: 'ja', zone: 'local', style: 'date', localTimeZone: 'Asia/Tokyo' })
				?.text
		).toBe('2026/09/27');
	});

	it('never shifts calendar dates', () => {
		for (const zone of ['utc', 'local'] as const) {
			expect(
				formatTime('2024-03-01', { locale: 'ja', zone, localTimeZone: 'America/Los_Angeles' })
			).toEqual({ text: '2024/03/01', zone: '', iso: '2024-03-01' });
		}
		expect(formatTime('2024-03', { locale: 'en', zone: 'local' })?.text).toBe('03/2024');
	});

	it('keeps a machine-readable ISO value', () => {
		expect(formatTime(instant, { locale: 'ja', zone: 'local' })?.iso).toBe(
			'2026-09-26T05:05:30.000Z'
		);
	});

	it('returns null for values that are not dates', () => {
		expect(formatTime('not a date', { locale: 'ja', zone: 'utc' })).toBeNull();
	});
});

describe('toDate', () => {
	it('accepts epoch seconds and milliseconds', () => {
		expect(toDate(1790000000)?.toISOString()).toBe('2026-09-21T14:13:20.000Z');
		expect(toDate(1790000000000)?.toISOString()).toBe('2026-09-21T14:13:20.000Z');
	});
});
