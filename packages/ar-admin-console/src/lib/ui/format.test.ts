import { describe, expect, it } from 'vitest';
import { formatBytes } from './format';

describe('formatBytes', () => {
	it('picks the largest whole unit', () => {
		expect(formatBytes(512, 'en')).toBe('512B');
		expect(formatBytes(2048, 'en')).toBe('2 kB');
		expect(formatBytes(5 * 1024 * 1024, 'en')).toBe('5 MB');
	});

	it('uses the locale decimal separator', () => {
		expect(formatBytes(1.5 * 1024 * 1024, 'de')).toBe('1,5 MB');
	});
});
