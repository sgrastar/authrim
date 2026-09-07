import { describe, expect, it } from 'vitest';
import { sanitizeFooterHtml } from './footer-html';

describe('sanitizeFooterHtml', () => {
	it('allows an anchor while removing every other tag and anchor attribute', () => {
		expect(
			sanitizeFooterHtml(
				'<strong>Powered by</strong> <a href="https://authrim.com/" onclick="alert(1)">Authrim</a>'
			)
		).toBe(
			'Powered by <a href="https:&#x2F;&#x2F;authrim.com&#x2F;" target="_blank" rel="noopener noreferrer">Authrim</a>'
		);
	});

	it('rejects unsafe anchor URLs', () => {
		expect(sanitizeFooterHtml('<a href="javascript:alert(1)">Authrim</a>')).toBe('Authrim');
	});
});
