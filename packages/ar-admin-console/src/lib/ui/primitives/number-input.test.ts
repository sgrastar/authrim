import { describe, expect, it } from 'vitest';
import { parseNumberInput, pickDurationUnit } from './number-input';

describe('parseNumberInput', () => {
	it('reads plain, grouped and full-width numbers', () => {
		expect(parseNumberInput('3600').value).toBe(3600);
		expect(parseNumberInput('86,400').value).toBe(86400);
		expect(parseNumberInput('１２０').value).toBe(120);
		expect(parseNumberInput(' 42 ').value).toBe(42);
	});

	it('treats an empty field as no value, not as a problem', () => {
		expect(parseNumberInput('')).toEqual({ value: null, problem: null });
	});

	it('explains what is wrong', () => {
		expect(parseNumberInput('12a').problem).toEqual({ kind: 'invalid' });
		expect(parseNumberInput('1.5').problem).toEqual({ kind: 'whole' });
		expect(parseNumberInput('1.5', { whole: false }).problem).toBeNull();
		expect(parseNumberInput('0', { min: 1, max: 10 }).problem).toEqual({
			kind: 'range',
			min: 1,
			max: 10
		});
		expect(parseNumberInput('0', { min: 1 }).problem).toEqual({ kind: 'min', min: 1 });
		expect(parseNumberInput('11', { max: 10 }).problem).toEqual({ kind: 'max', max: 10 });
	});
});

describe('pickDurationUnit', () => {
	const all = ['seconds', 'minutes', 'hours', 'days'] as const;

	it('uses the largest unit that keeps a whole number', () => {
		expect(pickDurationUnit(86400, all)).toBe('days');
		expect(pickDurationUnit(5400, all)).toBe('minutes');
		expect(pickDurationUnit(45, all)).toBe('seconds');
	});

	it('stays within the allowed units', () => {
		expect(pickDurationUnit(86400, ['minutes', 'hours'])).toBe('hours');
		expect(pickDurationUnit(30, ['minutes', 'hours'])).toBe('minutes');
	});

	it('starts from the smallest allowed unit when there is no value', () => {
		expect(pickDurationUnit(null, ['hours', 'days'])).toBe('hours');
	});
});
