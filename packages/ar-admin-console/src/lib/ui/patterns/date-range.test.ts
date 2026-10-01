import { describe, expect, it } from 'vitest';
import { fromInputValue, isReversed, resolveRange, toInputValue } from './date-range';

describe('resolveRange', () => {
	const now = new Date('2026-09-28T12:00:00Z');

	it('turns a preset into a span ending now', () => {
		expect(resolveRange({ preset: '24h' }, now)).toEqual({
			from: new Date('2026-09-27T12:00:00Z'),
			to: now
		});
	});

	it('keeps open sides of a custom range open', () => {
		expect(resolveRange({ preset: 'custom', from: '2026-09-01T00:00:00.000Z' }, now)).toEqual({
			from: new Date('2026-09-01T00:00:00Z'),
			to: undefined
		});
	});
});

describe('isReversed', () => {
	it('flags a custom range that ends before it starts', () => {
		expect(
			isReversed({ preset: 'custom', from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' })
		).toBe(true);
		expect(isReversed({ preset: 'custom', from: '2026-09-01T00:00:00Z' })).toBe(false);
	});
});

describe('datetime-local values', () => {
	it('reads and writes UTC exactly', () => {
		expect(toInputValue('2026-09-28T14:05:00.000Z', 'utc')).toBe('2026-09-28T14:05');
		expect(fromInputValue('2026-09-28T14:05', 'utc')).toBe('2026-09-28T14:05:00.000Z');
	});

	it('round-trips local time to the same instant', () => {
		const iso = '2026-09-28T14:05:00.000Z';
		expect(fromInputValue(toInputValue(iso, 'local'), 'local')).toBe(iso);
	});

	it('treats an empty field as no bound', () => {
		expect(fromInputValue('', 'local')).toBeUndefined();
		expect(toInputValue(undefined, 'utc')).toBe('');
	});
});
