import { describe, expect, it } from 'vitest';
import { contrastRatio, normalizeHex } from './color';

describe('normalizeHex', () => {
	it('accepts short and long forms, with or without #', () => {
		expect(normalizeHex('#ABC')).toBe('#aabbcc');
		expect(normalizeHex('3f4fc4')).toBe('#3f4fc4');
		expect(normalizeHex(' #3F4FC4 ')).toBe('#3f4fc4');
	});

	it('rejects anything else', () => {
		expect(normalizeHex('blue')).toBeNull();
		expect(normalizeHex('#12345')).toBeNull();
	});
});

describe('contrastRatio', () => {
	it('matches the WCAG extremes and is symmetric', () => {
		expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
		expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
		expect(contrastRatio('#ffffff', '#777777')).toBeCloseTo(
			contrastRatio('#777777', '#ffffff'),
			10
		);
	});
});
