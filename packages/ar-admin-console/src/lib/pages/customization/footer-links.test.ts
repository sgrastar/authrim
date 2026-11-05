import { describe, expect, it } from 'vitest';
import { parseFooter } from './footer-links';

describe('parseFooter', () => {
	it('splits the default footer into text and a link', () => {
		expect(parseFooter('Powered by <a href="https://authrim.com/">Authrim</a>')).toEqual([
			{ text: 'Powered by ' },
			{ href: 'https://authrim.com/', text: 'Authrim' }
		]);
	});

	it('keeps text after a link and handles several links', () => {
		expect(
			parseFooter('<a href=\'https://a.example\'>A</a> and <a href="http://b.example">B</a>!')
		).toEqual([
			{ href: 'https://a.example', text: 'A' },
			{ text: ' and ' },
			{ href: 'http://b.example', text: 'B' },
			{ text: '!' }
		]);
	});

	it('returns plain text as it is, and nothing for an empty footer', () => {
		expect(parseFooter('© Example')).toEqual([{ text: '© Example' }]);
		expect(parseFooter('')).toEqual([]);
	});

	it('does not turn other markup or other schemes into anything', () => {
		const script = '<script>alert(1)</script>';
		expect(parseFooter(script)).toEqual([{ text: script }]);
		const js = '<a href="javascript:alert(1)">x</a>';
		expect(parseFooter(js)).toEqual([{ text: js }]);
		const nested = '<a href="https://a.example"><b>x</b></a>';
		expect(parseFooter(nested)).toEqual([{ text: nested }]);
	});
});
