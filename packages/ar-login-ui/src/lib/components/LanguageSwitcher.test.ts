import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./LanguageSwitcher.svelte', import.meta.url), 'utf8');

describe('LanguageSwitcher accessibility structure', () => {
	it('keeps a keyboard-native labelled select and exposes the all-languages group', () => {
		expect(source).toContain('<select');
		expect(source).toContain('aria-label={$LL.language_switch()}');
		expect(source).toContain('<optgroup label={selectorModel.allLanguagesLabel}>');
	});

	it('keeps the selected locale on the select and stable keyed options during regrouping', () => {
		expect(source).toContain('value={currentLang}');
		expect(source).toContain('as option (option.locale)');
	});

	it('does not render a heading or optgroup for main languages', () => {
		const mainBlock = source.slice(
			source.indexOf('{#each selectorModel.mainOptions'),
			source.indexOf('<optgroup label={selectorModel.allLanguagesLabel}>')
		);
		expect(mainBlock).toContain('<option');
		expect(mainBlock).not.toContain('<optgroup');
		expect(mainBlock).not.toContain('<h');
	});

	it('repeats all enabled locales inside the all-languages group', () => {
		expect(source).toContain('{#each selectorModel.allLanguageOptions as option (option.locale)}');
	});
});
