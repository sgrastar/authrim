import { describe, expect, it } from 'vitest';
import { toDateTimeLocalValue } from './datetime-local';

const pad = (value: number) => String(value).padStart(2, '0');

describe('datetime-local formatting', () => {
	it('formats the visible local wall-clock value instead of UTC', () => {
		const date = new Date('2026-08-02T02:42:46.000Z');
		expect(toDateTimeLocalValue(date)).toBe(
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
		);
	});

	it('rejects invalid dates', () => {
		expect(() => toDateTimeLocalValue(new Date(Number.NaN))).toThrow(
			'invalid_datetime_local_value'
		);
	});
});
