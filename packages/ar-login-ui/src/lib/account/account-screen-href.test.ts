import { describe, expect, it } from 'vitest';
import { safeAccountScreenHref } from './account-screen-href';

const shown = new Set(['profile', 'security-keys']);
const isShown = (id: string) => shown.has(id);

describe('safeAccountScreenHref', () => {
	it('keeps anchors only to placements the page shows', () => {
		expect(safeAccountScreenHref('#profile', isShown)).toBe('#profile');
		expect(safeAccountScreenHref('#security-keys', isShown)).toBe('#security-keys');
		expect(safeAccountScreenHref('#activity', isShown)).toBeNull();
		expect(safeAccountScreenHref('#1-not-an-id', isShown)).toBeNull();
	});

	it('keeps same-origin paths and https URLs', () => {
		expect(safeAccountScreenHref('/account/security', isShown)).toBe('/account/security');
		expect(safeAccountScreenHref('https://help.example.com/account', isShown)).toBe(
			'https://help.example.com/account'
		);
	});

	it('drops other schemes, protocol-relative URLs and empty values', () => {
		for (const value of [
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'http://example.com',
			'//evil.example',
			'/\\evil.example',
			'not a url',
			'',
			null,
			undefined
		]) {
			expect(safeAccountScreenHref(value, isShown)).toBeNull();
		}
	});
});
