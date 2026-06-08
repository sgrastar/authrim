import { describe, expect, it } from 'vitest';
import { sanitizeText } from './sanitize';

describe('sanitizeText', () => {
	it('neutralizes dangerous schemes with embedded whitespace', () => {
		expect(sanitizeText('java\tscript:alert(1)')).toBe('java\tscriptalert(1)');
		expect(sanitizeText('d\na\rt\ta:payload')).toBe('d a t\tapayload');
	});
});
