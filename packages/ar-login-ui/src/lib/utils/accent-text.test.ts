import { describe, expect, it } from 'vitest';
import { accentTextColor } from './accent-text';

describe('accentTextColor', () => {
	it('picks the text that reads better on the accent', () => {
		expect(accentTextColor('#2563eb')).toBe('#ffffff');
		expect(accentTextColor('#e8623f')).toBe('#111111');
		expect(accentTextColor('#16a34a')).toBe('#111111');
		expect(accentTextColor('#fde047')).toBe('#111111');
		expect(accentTextColor('#123')).toBe('#ffffff');
		expect(accentTextColor('rgb(37, 99, 235)')).toBe('#ffffff');
		expect(accentTextColor('hsl(48, 96%, 63%)')).toBe('#111111');
	});

	it('gives nothing for a colour it cannot read', () => {
		expect(accentTextColor('')).toBeNull();
		expect(accentTextColor('red')).toBeNull();
		expect(accentTextColor(undefined)).toBeNull();
	});
});
