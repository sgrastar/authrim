import { describe, expect, it } from 'vitest';
import { normalizePinCode, normalizePinCodeLength } from './pin-code';

describe('normalizePinCode', () => {
	it('keeps numeric keypad input and limits it to the configured length', () => {
		expect(normalizePinCode('1234567', 6)).toBe('123456');
	});

	it('normalizes pasted and composed input to ASCII digits', () => {
		expect(normalizePinCode('12 3-4a56', 6)).toBe('123456');
	});
});

describe('normalizePinCodeLength', () => {
	it('keeps the layout within the supported range', () => {
		expect(normalizePinCodeLength(Number.NaN)).toBe(6);
		expect(normalizePinCodeLength(0)).toBe(1);
		expect(normalizePinCodeLength(20)).toBe(12);
	});
});
