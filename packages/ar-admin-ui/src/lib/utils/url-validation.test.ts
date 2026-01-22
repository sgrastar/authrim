/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isValidDownloadUrl } from './url-validation';

describe('url-validation', () => {
	describe('isValidDownloadUrl', () => {
		beforeEach(() => {
			// Set up window.location.origin for tests
			Object.defineProperty(window, 'location', {
				value: {
					origin: 'https://example.com',
					href: 'https://example.com/admin/jobs'
				},
				writable: true
			});
		});

		it('returns false for empty string', () => {
			expect(isValidDownloadUrl('')).toBe(false);
		});

		it('returns false for null-like values', () => {
			// @ts-expect-error - testing null
			expect(isValidDownloadUrl(null)).toBe(false);
			// @ts-expect-error - testing undefined
			expect(isValidDownloadUrl(undefined)).toBe(false);
		});

		it('returns true for same-origin URLs', () => {
			expect(isValidDownloadUrl('https://example.com/downloads/report.pdf')).toBe(true);
			expect(isValidDownloadUrl('/downloads/report.pdf')).toBe(true);
		});

		it('returns true for trusted domain (storage.googleapis.com)', () => {
			expect(isValidDownloadUrl('https://storage.googleapis.com/bucket/file.pdf')).toBe(true);
		});

		it('returns true for single-level subdomain of trusted domain', () => {
			expect(isValidDownloadUrl('https://mybucket.storage.googleapis.com/file.pdf')).toBe(true);
		});

		it('returns false for deeply nested subdomain of trusted domain', () => {
			expect(isValidDownloadUrl('https://deep.nested.storage.googleapis.com/file.pdf')).toBe(false);
		});

		it('returns false for HTTP URLs (non-HTTPS)', () => {
			expect(isValidDownloadUrl('http://storage.googleapis.com/bucket/file.pdf')).toBe(false);
		});

		it('returns false for untrusted domains', () => {
			expect(isValidDownloadUrl('https://malicious.com/file.pdf')).toBe(false);
			expect(isValidDownloadUrl('https://storage.evilsite.com/file.pdf')).toBe(false);
		});

		it('returns false for domain spoofing attempts', () => {
			// Trying to spoof trusted domain
			expect(isValidDownloadUrl('https://storage.googleapis.com.malicious.com/file.pdf')).toBe(
				false
			);
			expect(isValidDownloadUrl('https://fakestorage.googleapis.com.evil.com/file.pdf')).toBe(
				false
			);
		});

		it('returns false for dangerous URL schemes', () => {
			// Note: 'not-a-url' is treated as a relative path (same-origin), so it's valid
			expect(isValidDownloadUrl('javascript:alert(1)')).toBe(false);
			expect(isValidDownloadUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
		});

		it('treats relative paths as same-origin (valid)', () => {
			// Relative paths are resolved against window.location.origin
			expect(isValidDownloadUrl('relative/path/file.pdf')).toBe(true);
			expect(isValidDownloadUrl('../file.pdf')).toBe(true);
		});

		it('returns false for file:// protocol', () => {
			expect(isValidDownloadUrl('file:///etc/passwd')).toBe(false);
		});

		it('handles URL with query parameters', () => {
			expect(
				isValidDownloadUrl('https://storage.googleapis.com/bucket/file.pdf?token=abc&expires=123')
			).toBe(true);
		});

		it('handles URL with fragments', () => {
			expect(isValidDownloadUrl('https://storage.googleapis.com/bucket/file.pdf#page=1')).toBe(
				true
			);
		});
	});
});
