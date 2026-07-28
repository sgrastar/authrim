import { describe, expect, it } from 'vitest';
import { sanitizeFooterHtml } from './footer-html';

describe('sanitizeFooterHtml', () => {
	it('keeps only a safe anchor and its href', () => {
		expect(
			sanitizeFooterHtml(
				'Powered by <a href="https://authrim.com/" class="ignored" onclick="alert(1)">Authrim</a>'
			)
		).toBe(
			'Powered by <a href="https:&#x2F;&#x2F;authrim.com&#x2F;" target="_blank" rel="noopener noreferrer">Authrim</a>'
		);
	});

	it('removes disallowed tags while preserving their text', () => {
		expect(sanitizeFooterHtml('<strong>Powered</strong> by <img src=x>Authrim')).toBe(
			'Powered by Authrim'
		);
	});

	it('rejects unsafe anchor URLs', () => {
		expect(sanitizeFooterHtml('<a href="javascript:alert(1)">Authrim</a>')).toBe('Authrim');
	});

	it('escapes text outside the permitted anchor', () => {
		expect(sanitizeFooterHtml('Powered & supported')).toBe('Powered &amp; supported');
	});
});
