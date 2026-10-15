import { describe, expect, it } from 'vitest';
import {
	USER_CODE_MAX_LENGTH,
	formatUserCode,
	isUserCodeComplete,
	userCodeCharacters
} from './device-user-code';

describe('userCodeCharacters', () => {
	it('keeps the letters and digits, in upper case', () => {
		expect(userCodeCharacters('abcd-efgh')).toBe('ABCDEFGH');
		expect(userCodeCharacters(' ab cd\tef　gh ')).toBe('ABCDEFGH');
		expect(userCodeCharacters('1234_5678.901!')).toBe('12345678901');
	});

	it('reads the full-width letters and digits an IME produces', () => {
		expect(userCodeCharacters('ＡＢＣＤ－１２３４')).toBe('ABCD1234');
		expect(userCodeCharacters('ａｂｃｄ　ｅｆｇｈ')).toBe('ABCDEFGH');
	});

	it('drops characters that are no letter or digit of a code', () => {
		expect(userCodeCharacters('ありがとう')).toBe('');
		expect(userCodeCharacters('ÄÖÜß')).toBe('');
		expect(userCodeCharacters('<b>AB</b>')).toBe('BABB');
	});

	it('stops at 16 characters', () => {
		expect(userCodeCharacters('A'.repeat(40))).toHaveLength(USER_CODE_MAX_LENGTH);
	});
});

describe('formatUserCode', () => {
	it.each([
		['', ''],
		['a', 'A'],
		['abcd', 'ABCD'],
		['abcde', 'ABCD-E'],
		['abcdefgh', 'ABCD-EFGH'],
		['abcd-efgh-jkm', 'ABCD-EFGH-JKM'],
		['12345678901', '1234-5678-901'],
		['ABCDEFGHJKMNPQRS', 'ABCD-EFGH-JKMN-PQRS'],
		['ABCDEFGHJKMNPQRSTUV', 'ABCD-EFGH-JKMN-PQRS'],
		['AB-CD-EF-GH', 'ABCD-EFGH']
	])('%s -> %s', (typed, shown) => {
		expect(formatUserCode(typed)).toBe(shown);
	});

	it('is stable: formatting a formatted code changes nothing', () => {
		for (let length = 0; length <= 20; length++) {
			const shown = formatUserCode('ABCDEFGHJKMNPQRSTUVW'.slice(0, length));
			expect(formatUserCode(shown)).toBe(shown);
		}
	});
});

describe('isUserCodeComplete', () => {
	it.each([
		['', false],
		['ABC', false],
		['ABCD', true],
		['ABCD-EFGH', true],
		['ABCD-EFGH-JKM', true],
		['ABCD-EFGH-JKMN-PQRS', true],
		['ABCD-EFGH-JKMN-PQRS-T', true] // the extra character is cut off by the formatter
	])('%s -> %s', (typed, complete) => {
		expect(isUserCodeComplete(typed)).toBe(complete);
	});
});
