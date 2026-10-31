import { describe, expect, it } from 'vitest';
import { asciiDigits, stripAccents } from './text-fold';

describe('stripAccents', () => {
	it('takes the marks off Latin letters and spells out the special ones', () => {
		expect(stripAccents('José Müller')).toBe('Jose Muller');
		expect(stripAccents('Ångström, Łódź, Straße, Søren, Œuvre')).toBe(
			'Angstrom, Lodz, Strasse, Soren, OEuvre'
		);
	});

	it('leaves other scripts alone, Japanese voiced kana included', () => {
		expect(stripAccents('ガギグ パ')).toBe('ガギグ パ');
		expect(stripAccents('مُحَمَّد')).toBe('مُحَمَّد');
	});
});

describe('asciiDigits', () => {
	it('turns every script’s digits into 0–9', () => {
		expect(asciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
		expect(asciiDigits('۱۴۰۳')).toBe('1403');
		expect(asciiDigits('१२३')).toBe('123');
		expect(asciiDigits('๒๕๖๗')).toBe('2567');
		expect(asciiDigits('１２３')).toBe('123');
	});

	it('leaves everything else as it is', () => {
		expect(asciiDigits('No. ٤٢ / 42')).toBe('No. 42 / 42');
	});
});
