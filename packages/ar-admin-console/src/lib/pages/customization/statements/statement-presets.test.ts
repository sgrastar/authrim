import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '#lib/i18n/locales.js';
import { SLUG_PATTERN } from './statement-model';
import { statementDescriptionHtml } from './statement-html';
import { generatedStatementSlug, statementPreset } from './statement-presets';

describe('statementPreset', () => {
	it('fills a terms of service and a privacy policy in every console language', () => {
		for (const kind of ['terms', 'privacy'] as const) {
			for (const code of SUPPORTED_LOCALES) {
				const preset = statementPreset(kind, code);
				expect(preset.title).not.toBe('');
				expect(preset.description).toContain(preset.title);
				expect(preset.description).not.toContain('%link1%');
			}
		}
		expect(statementPreset('terms', 'ja')).toEqual({
			title: '利用規約',
			description: '利用規約を読み、その内容に同意します。'
		});
	});

	it('links the name to the document once its link is a web address', () => {
		expect(statementPreset('privacy', 'en', ' https://example.com/privacy?a=1&b=2 ')).toEqual({
			title: 'Privacy Policy',
			description:
				'I have read and agree to the <a href="https://example.com/privacy?a=1&b=2">Privacy Policy</a>.'
		});
		// Shown as the sign-in screen shows it, the link goes where it was typed to.
		const shown = document.createElement('div');
		shown.innerHTML = statementDescriptionHtml(
			statementPreset('privacy', 'en', 'https://example.com/privacy?a=1&b=2').description
		);
		expect(shown.querySelector('a')?.getAttribute('href')).toBe(
			'https://example.com/privacy?a=1&b=2'
		);
		expect(statementPreset('terms', 'en', 'https://example.com/"><script>').description).toBe(
			'I have read and agree to the Terms of Service.'
		);
		expect(statementPreset('terms', 'ja', 'javascript:alert(1)').description).toBe(
			'利用規約を読み、その内容に同意します。'
		);
	});

	it('fills nothing for Other or a language without words', () => {
		expect(statementPreset('other', 'ja')).toEqual({ title: '', description: '' });
		expect(statementPreset('terms', 'fr')).toEqual({ title: '', description: '' });
	});
});

describe('generatedStatementSlug', () => {
	it('is a valid key of its kind with a random part', () => {
		const fixed = (bytes: Uint8Array) => bytes.fill(171);
		expect(generatedStatementSlug('terms', fixed)).toBe('terms-ababababab');
		expect(generatedStatementSlug('other', fixed)).toBe('statement-ababababab');
		const made = generatedStatementSlug('privacy');
		expect(made).toMatch(/^privacy-[0-9a-f]{10}$/u);
		expect(SLUG_PATTERN.test(made)).toBe(true);
		expect(generatedStatementSlug('privacy')).not.toBe(made);
	});
});
