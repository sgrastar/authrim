import { describe, expect, it } from 'vitest';
import { ar } from './messages/ar';
import { de } from './messages/de';
import { en } from './messages/en';
import { ja } from './messages/ja';

const locales = { en, de, ar };

describe('message catalogs', () => {
	it('provide every source key in every locale, with no extras', () => {
		const source = Object.keys(ja).sort();
		for (const [name, catalog] of Object.entries(locales)) {
			expect(Object.keys(catalog).sort(), name).toEqual(source);
		}
	});

	it('keep the same placeholders as the source text', () => {
		const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
		for (const [key, value] of Object.entries(ja)) {
			for (const [name, catalog] of Object.entries(locales)) {
				expect(placeholders(catalog[key as keyof typeof ja]), `${name}:${key}`).toEqual(
					placeholders(value)
				);
			}
		}
	});

	it('contain plain text only (messages are never rendered as HTML)', () => {
		for (const catalog of [ja, en, de, ar]) {
			for (const value of Object.values(catalog)) {
				expect(value).not.toMatch(/<[a-z/]/i);
			}
		}
	});
});
