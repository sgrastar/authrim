import { describe, expect, it } from 'vitest';
import { toFullwidth, toHalfwidth } from './text-width';

describe('toHalfwidth', () => {
	it('turns full-width letters, digits, symbols and spaces half-width', () => {
		expect(toHalfwidth('ＡＢＣ　１２３＠ｅｘａｍｐｌｅ．ｃｏｍ', false)).toBe(
			'ABC 123@example.com'
		);
	});

	it('leaves katakana unless asked, then splits voiced kana', () => {
		expect(toHalfwidth('ヤマダ　タロウ', false)).toBe('ヤマダ タロウ');
		expect(toHalfwidth('ヤマダ　タロウ', true)).toBe('ﾔﾏﾀﾞ ﾀﾛｳ');
		expect(toHalfwidth('パスポート。', true)).toBe('ﾊﾟｽﾎﾟｰﾄ｡');
		expect(toHalfwidth('ヴ', true)).toBe('ｳﾞ');
	});

	it('does not touch hiragana or kanji', () => {
		expect(toHalfwidth('山田たろう', true)).toBe('山田たろう');
	});
});

describe('toFullwidth', () => {
	it('turns half-width letters, digits, symbols and spaces full-width', () => {
		expect(toFullwidth('ABC 123', false)).toBe('ＡＢＣ　１２３');
	});

	it('combines half-width voiced kana when asked', () => {
		expect(toFullwidth('ﾔﾏﾀﾞ ﾀﾛｳ', false)).toBe('ﾔﾏﾀﾞ　ﾀﾛｳ');
		expect(toFullwidth('ﾔﾏﾀﾞ ﾀﾛｳ', true)).toBe('ヤマダ　タロウ');
		expect(toFullwidth('ﾊﾟｽﾎﾟｰﾄ', true)).toBe('パスポート');
	});
});
