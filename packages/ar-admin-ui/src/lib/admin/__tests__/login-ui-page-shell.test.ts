import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
	resolve(__dirname, '../../../routes/admin/login-ui/+page.svelte'),
	'utf8'
);

describe('Login UI settings page shell', () => {
	it('removes the redundant outer border from settings panels', () => {
		expect(source).toMatch(/\.settings-detail-page\s*\{[^}]*--panel-border:\s*none;/);
	});

	it('shows primary-language controls only when at least 11 languages are enabled', () => {
		expect(source).toContain('enabledLocales.length >= LOGIN_UI_LANGUAGE_GROUPING_THRESHOLD');
		expect(source).toContain('{#if languageGroupingEnabled}');
		expect(source).toContain('{#if enabledLocales.includes(locale.code)}');
	});

	it('disables a seventh primary-language checkbox and associates help text', () => {
		expect(source).toContain('effectivePrimaryLocales.length >= MAX_LOGIN_UI_PRIMARY_LOCALES');
		expect(source).toContain('aria-describedby="primary-language-help"');
		expect(source).toContain('aria-describedby="show-english-language-names-description"');
	});

	it('keeps the saved primary selection when the enabled list is reduced below 11', () => {
		const clearAllFunction = source.slice(
			source.indexOf('function clearAllLocalesExceptDefault'),
			source.indexOf('function discardLanguageChanges')
		);
		expect(clearAllFunction).not.toContain('primaryLocales =');
	});
});
