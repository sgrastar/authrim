import { describe, expect, it } from 'vitest';
import { contrastRatio, joinAlpha, normalizeHex, splitAlpha } from './color';

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

describe('opacity in a colour', () => {
	it('splits a colour from its opacity', () => {
		expect(splitAlpha('#3f4fc4')).toEqual({ rgb: '#3f4fc4', alpha: 100 });
		expect(splitAlpha('#3f4fc480')).toEqual({ rgb: '#3f4fc4', alpha: 50 });
		expect(splitAlpha('#3F4FC400')).toEqual({ rgb: '#3f4fc4', alpha: 0 });
		expect(splitAlpha('')).toEqual({ rgb: '', alpha: 100 });
	});

	it('writes six digits when opaque and eight otherwise', () => {
		expect(joinAlpha('#3f4fc4', 100)).toBe('#3f4fc4');
		expect(joinAlpha('#3f4fc4', 50)).toBe('#3f4fc480');
		expect(joinAlpha('#3f4fc4', 0)).toBe('#3f4fc400');
	});

	it('keeps the opacity a person sees through a round trip', () => {
		for (const alpha of [0, 10, 25, 33, 50, 70, 99]) {
			expect(splitAlpha(joinAlpha('#112233', alpha)).alpha).toBe(alpha);
		}
	});
});
