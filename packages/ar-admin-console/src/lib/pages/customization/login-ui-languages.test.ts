import { describe, expect, it } from 'vitest';
import {
	automaticFirst,
	changesBetween,
	KEYS,
	LOCALES,
	parseShown,
	shownWithDefault,
	valuesFrom
} from './login-ui-languages';

const inOrder = (codes: string[]) =>
	[...codes].sort((a, b) => LOCALES.indexOf(a as never) - LOCALES.indexOf(b as never));

describe('the Login UI page’s languages', () => {
	it('reads the languages shown from the comma list, known ones once each, in canonical order', () => {
		expect(parseShown(' ja, en ,xx,en,zh-CN')).toEqual(inOrder(['en', 'ja', 'zh-CN']));
		expect(parseShown(undefined)).toEqual([]);
	});

	it('keeps the saved default even when it is not among the languages shown', () => {
		const values = valuesFrom({
			'login-ui.supported_locales': 'ja,en',
			'login-ui.default_locale': 'de'
		});
		// Neither value is corrected on its own.
		expect(values.shown).toEqual(inOrder(['ja', 'en']));
		expect(values.defaultLang).toBe('de');
		expect(changesBetween(values, values)).toEqual({});
		// The default counts as shown: saving the languages shown includes it.
		expect(shownWithDefault(values)).toEqual(inOrder(['ja', 'en', 'de']));
		// "Listed first" may name the default too.
		const withFirst = valuesFrom({
			'login-ui.supported_locales': 'ja,en',
			'login-ui.default_locale': 'de',
			'login-ui.primary_locales': ['de', 'fr']
		});
		expect(withFirst.first).toEqual(['de']);
		const set = changesBetween(values, { ...values, shown: inOrder(['ja']) as never });
		expect(set).toEqual({ [KEYS.shown]: inOrder(['ja', 'de']).join(',') });
	});

	it('keeps "listed first" automatic (null) until the admin chooses', () => {
		const all = LOCALES.join(',');
		const automatic = valuesFrom({ 'login-ui.supported_locales': all });
		expect(automatic.first).toBeNull();
		expect(automaticFirst(automatic.shown)).toHaveLength(6);
		const chosen = valuesFrom({
			'login-ui.supported_locales': all,
			'login-ui.primary_locales': ['ja', 'de', 'xx']
		});
		expect(chosen.first).toEqual(['ja', 'de']);
		// Choosing sends the list; going back to automatic sends null; an empty choice is kept.
		expect(changesBetween(automatic, { ...automatic, first: ['ja'] })[KEYS.first]).toEqual(['ja']);
		expect(changesBetween(chosen, { ...chosen, first: null })[KEYS.first]).toBeNull();
		expect(changesBetween(chosen, { ...chosen, first: [] })[KEYS.first]).toEqual([]);
	});

	it('sends only what changed, the shown list as a comma string in canonical order', () => {
		const saved = valuesFrom({
			'login-ui.supported_locales': LOCALES.join(','),
			'login-ui.default_locale': 'en',
			'login-ui.primary_locales': ['en', 'ja', 'de']
		});
		expect(changesBetween(saved, saved)).toEqual({});
		const screen = { ...saved, shown: inOrder(['ja', 'en']) as never, englishNames: true };
		const set = changesBetween(saved, screen);
		expect(set['login-ui.supported_locales']).toBe(inOrder(['en', 'ja']).join(','));
		expect(set['login-ui.show_english_language_names']).toBe(true);
		// Languages no longer shown drop out of "listed first".
		expect(set['login-ui.primary_locales']).toEqual(['en', 'ja']);
	});

	it('never sends a setting the platform has fixed', () => {
		const saved = valuesFrom({
			'login-ui.supported_locales': LOCALES.join(','),
			'login-ui.default_locale': 'en'
		});
		const screen = { ...saved, shown: inOrder(['ja', 'en']) as never, englishNames: true };
		const set = changesBetween(saved, screen, new Set([KEYS.shown]));
		expect(set).toEqual({ [KEYS.englishNames]: true });
	});

	it('carries the lite logo with the languages, sent only when it changes', () => {
		const saved = valuesFrom({
			'login-ui.supported_locales': 'en',
			'login-ui.default_locale': 'en',
			'login-ui.lite_logo': 'data:image/png;base64,AAAA'
		});
		expect(saved.liteLogo).toBe('data:image/png;base64,AAAA');
		expect(changesBetween(saved, saved)).toEqual({});
		expect(changesBetween(saved, { ...saved, liteLogo: '' })).toEqual({ [KEYS.liteLogo]: '' });
	});
});
