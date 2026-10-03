import { describe, expect, it } from 'vitest';
import { accentTextColor, normalizeAccentColor } from './accent-text';
import { sanitizeColor } from './url-validation';

function contrast(a: string, b: string): number {
	const lum = (hex: string) =>
		[1, 3, 5]
			.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
			.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
			.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

describe('accent colours', () => {
	it('applies an accent opaque, from hex, rgb() or hsl()', () => {
		expect(normalizeAccentColor('#123')).toBe('#112233');
		expect(normalizeAccentColor('#2563EB')).toBe('#2563eb');
		expect(normalizeAccentColor('rgba(0, 0, 0, 0.01)')).toBe('#000000');
		expect(normalizeAccentColor('rgb(37, 99, 235)')).toBe('#2563eb');
	});

	it('does not apply a colour it cannot resolve the same everywhere', () => {
		for (const value of [
			'',
			'yellow',
			'red',
			'rgb(300, 0, 0)',
			'rgb(0,0,0,)',
			'#2563eb80',
			'hsl(48, 96%, 63%)',
			undefined
		]) {
			expect(normalizeAccentColor(value)).toBeNull();
			expect(accentTextColor(value)).toBeNull();
		}
	});

	it('gives every opaque accent a label of at least 4.5:1', () => {
		for (let v = 0; v <= 255; v += 1) {
			const grey = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
			expect(contrast(accentTextColor(grey)!, grey), grey).toBeGreaterThanOrEqual(4.5);
		}
		for (const accent of ['#2563eb', '#16a34a', '#e8623f', '#fde047', '#797979', '#7a7a7a']) {
			expect(contrast(accentTextColor(accent)!, accent), accent).toBeGreaterThanOrEqual(4.5);
		}
	});

	it('applies only colours sanitizeColor also lets through', () => {
		for (const value of [
			'#abc',
			'#a1b2c3',
			'rgb(1, 2, 3)',
			'rgba(1, 2, 3, 0.5)',
			'rgb(0,0,0,)',
			'#a1b2c3d4'
		]) {
			if (normalizeAccentColor(value)) expect(sanitizeColor(value), value).not.toBe('');
		}
	});
});
