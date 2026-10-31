import { describe, expect, it } from 'vitest';
import { pseudoLocalize } from './pseudo';

describe('pseudoLocalize', () => {
	it('accents letters and brackets the text', () => {
		const out = pseudoLocalize('Save');
		expect(out.startsWith('[Šåṽé')).toBe(true);
		expect(out.endsWith(']')).toBe(true);
	});

	it('makes short labels much longer and long sentences somewhat longer', () => {
		const short = 'Save';
		const long = 'Registered passkeys are used to sign in to this admin console.';
		expect(pseudoLocalize(short).length).toBeGreaterThanOrEqual(short.length * 1.8);
		const ratio = pseudoLocalize(long).length / long.length;
		expect(ratio).toBeGreaterThan(1.3);
		expect(ratio).toBeLessThan(1.5);
	});

	it('keeps placeholders so values are still filled in', () => {
		const out = pseudoLocalize('Delete “{name}”?');
		expect(out).toContain('{name}');
		expect(out).toContain('Ðéļéţé');
	});

	it('leaves digits, punctuation and non-Latin text as they are', () => {
		expect(pseudoLocalize('12/100')).toContain('12/100');
		expect(pseudoLocalize('設定')).toContain('設定');
	});

	it('keeps empty text empty', () => {
		expect(pseudoLocalize('')).toBe('');
	});
});
