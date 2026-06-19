import { describe, expect, it } from 'vitest';
import { resolveTurnstileLanguage } from './turnstile-options';

describe('resolveTurnstileLanguage', () => {
	it('uses Japanese when the page language is Japanese', () => {
		expect(resolveTurnstileLanguage('ja')).toBe('ja');
		expect(resolveTurnstileLanguage('ja-JP')).toBe('ja');
	});

	it('uses English for non-Japanese languages and empty values', () => {
		expect(resolveTurnstileLanguage('en')).toBe('en');
		expect(resolveTurnstileLanguage('de')).toBe('en');
		expect(resolveTurnstileLanguage('', 'en')).toBe('en');
	});

	it('falls back to the current locale when the html lang is unavailable', () => {
		expect(resolveTurnstileLanguage(null, 'ja')).toBe('ja');
		expect(resolveTurnstileLanguage(undefined, 'en')).toBe('en');
	});
});
