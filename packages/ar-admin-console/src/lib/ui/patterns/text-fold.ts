/**
 * Folding text to plain Latin letters and ASCII digits, for systems that accept nothing else
 * (user names, the local part of an email address, IDs).
 */

/** The combining marks Latin, Greek and Cyrillic letters carry (e + U+0301 = é). */
const LATIN_MARKS: readonly (readonly [number, number])[] = [
	[0x0300, 0x036f],
	[0x1ab0, 0x1aff],
	[0x1dc0, 0x1dff],
	[0x20d0, 0x20ff],
	[0xfe20, 0xfe2f]
];

const isLatinMark = (c: string) => {
	const code = c.codePointAt(0) ?? 0;
	return LATIN_MARKS.some(([from, to]) => code >= from && code <= to);
};

/** Letters that are not a base letter plus a mark, so decomposing does not reach them. */
const LETTERS: Readonly<Record<string, string>> = {
	ß: 'ss',
	ẞ: 'SS',
	æ: 'ae',
	Æ: 'AE',
	œ: 'oe',
	Œ: 'OE',
	ø: 'o',
	Ø: 'O',
	ł: 'l',
	Ł: 'L',
	đ: 'd',
	Đ: 'D',
	ð: 'd',
	Ð: 'D',
	þ: 'th',
	Þ: 'TH',
	ı: 'i'
};
const LETTER = new RegExp(`[${Object.keys(LETTERS).join('')}]`, 'gu');

/**
 * "José Müller" → "Jose Muller", "Straße" → "Strasse". Only the marks of Latin-script
 * languages go: Japanese voiced marks (ガ), Arabic, Hebrew and Indic signs stay as they are.
 */
export function stripAccents(text: string): string {
	return [...text.normalize('NFD')]
		.filter((c) => !isLatinMark(c))
		.join('')
		.normalize('NFC')
		.replace(LETTER, (c) => LETTERS[c] ?? c);
}

const DIGIT = /\p{Nd}/u;

/**
 * Every script's digits to 0–9: "٠١٢٣" (Arabic-Indic), "۴۵۶" (Persian), "१२३" (Devanagari),
 * "１２３" (full-width) → "0123", "456", "123", "123". Unicode keeps each script's digits as
 * a run of ten code points from zero, so a digit's value is its place in its run.
 */
export function asciiDigits(text: string): string {
	return text.replace(/\p{Nd}/gu, (c) => {
		const code = c.codePointAt(0) ?? 0;
		let start = code;
		while (start > 0 && DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
		return String((code - start) % 10);
	});
}
