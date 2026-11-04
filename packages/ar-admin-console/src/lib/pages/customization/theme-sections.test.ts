import { describe, expect, it } from 'vitest';
import { en } from '../../i18n/messages/en.js';
import { ja } from '../../i18n/messages/ja.js';
import { newThemeDraft, SPLIT_CHOICES, TEXT_LANGUAGES } from './theme-draft';
import { PREVIEW_SCREENS, THEME_SECTIONS } from './theme-sections';

describe('Themes page', () => {
	it('has one tab per section, each with its own id', () => {
		const ids = THEME_SECTIONS.map((section) => section.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('uses only messages that exist in the source locale and English', () => {
		const keys = [
			...THEME_SECTIONS.map((section) => section.tab),
			...PREVIEW_SCREENS.map((screen) => screen.label)
		];
		for (const key of keys) {
			expect(ja[key], key).toBeTruthy();
			expect(en[key], key).toBeTruthy();
		}
	});

	it('has a label in every locale for each choice of the Split panel', () => {
		for (const [group, values] of Object.entries(SPLIT_CHOICES)) {
			for (const value of values) {
				const key = `th.${group}.${value}` as keyof typeof ja;
				expect(ja[key], key).toBeTruthy();
				expect(en[key], key).toBeTruthy();
			}
		}
	});

	it('starts with texts for every language and every screen, all empty (the default wording)', () => {
		const draft = newThemeDraft();
		for (const language of TEXT_LANGUAGES) {
			const texts = draft.texts[language.value];
			expect(Object.keys(texts.titles).sort()).toEqual(PREVIEW_SCREENS.map((s) => s.value).sort());
			expect(Object.values(texts.titles).every((title) => title === '')).toBe(true);
		}
	});
});
