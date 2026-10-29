import { describe, expect, it } from 'vitest';
import {
	checkKey,
	checkLabel,
	checkNamespace,
	checkRules,
	emptyRulesForm,
	formFromRules,
	isSafeRegex,
	rulesFromForm
} from './schema-validation';

const none = new Set<string>();

describe('the key of an attribute', () => {
	it('is snake_case, starts with a letter, and is at most 64 characters', () => {
		const ok = { reserved: none, taken: none };
		expect(checkKey('employee_id', ok)).toBeNull();
		expect(checkKey('', ok)).toBe('empty');
		for (const bad of ['Employee', '1abc', 'a-b', 'a b', '_a', 'é', 'a'.repeat(65)])
			expect(checkKey(bad, ok), bad).toBe('pattern');
		expect(checkKey('a'.repeat(64), ok)).toBeNull();
	});

	it('says why: reserved, or already used by an active attribute', () => {
		const options = { reserved: new Set(['email', 'sub']), taken: new Set(['employee_id']) };
		expect(checkKey('email', options)).toBe('reserved');
		expect(checkKey('employee_id', options)).toBe('taken');
		expect(checkKey('badge_number', options)).toBeNull();
	});

	it('must differ from the current key when it is a rename', () => {
		expect(checkKey('a_key', { reserved: none, taken: none, current: 'a_key' })).toBe('same');
		expect(checkKey('b_key', { reserved: none, taken: none, current: 'a_key' })).toBeNull();
	});
});

describe('texts', () => {
	it('needs a label, up to 255 characters', () => {
		expect(checkLabel('  ')).toBe('empty');
		expect(checkLabel('Employee ID')).toBeNull();
		expect(checkLabel('x'.repeat(256))).toBe('too_long');
	});

	it('takes a claim namespace that is empty or an http(s) address', () => {
		expect(checkNamespace('')).toBeNull();
		expect(checkNamespace('https://example.com/claims/')).toBeNull();
		expect(checkNamespace('urn:example')).toBe('scheme');
		expect(checkNamespace(`https://${'a'.repeat(260)}`)).toBe('too_long');
	});
});

describe('a pattern', () => {
	it('is accepted when it is short, valid and cannot blow up', () => {
		expect(isSafeRegex('^[A-Z]{2}\\d{4}$')).toBe(true);
		expect(isSafeRegex('^(a|b)$')).toBe(true);
	});

	it('is refused when it is invalid, long, or nests quantifiers', () => {
		expect(isSafeRegex('(')).toBe(false);
		expect(isSafeRegex('a'.repeat(129))).toBe(false);
		for (const bad of ['(a+)+', '(?:a+)*', '(a|b)+', 'a+*', 'a{2}{3}'])
			expect(isSafeRegex(bad), bad).toBe(false);
	});
});

describe('the rules of a type', () => {
	it('keeps only the rules its type takes', () => {
		const form = { ...emptyRulesForm(), minLength: '2', maxLength: '8', min: '1', pattern: '^a' };
		expect(rulesFromForm('string', form)).toEqual({ min_length: 2, max_length: 8, pattern: '^a' });
		expect(rulesFromForm('number', form)).toEqual({ min: 1 });
		expect(rulesFromForm('boolean', form)).toBeNull();
		expect(rulesFromForm('string', emptyRulesForm())).toBeNull();
	});

	it('round-trips through the form', () => {
		const rules = { min_length: 1, max_length: 5, pattern: 'x' };
		expect(rulesFromForm('string', formFromRules(rules))).toEqual(rules);
		expect(rulesFromForm('enum', formFromRules({ enum_values: ['a', 'b'] }))).toEqual({
			enum_values: ['a', 'b']
		});
	});

	it('refuses a string length out of order, a pattern that is unsafe and half-typed numbers', () => {
		expect(checkRules('string', { ...emptyRulesForm(), minLength: '5', maxLength: '2' })).toEqual({
			maxLength: 'length_order'
		});
		expect(checkRules('string', { ...emptyRulesForm(), maxLength: '0' }).maxLength).toBe(
			'max_length_invalid'
		);
		expect(checkRules('string', { ...emptyRulesForm(), minLength: '1.5' }).minLength).toBe(
			'min_length_invalid'
		);
		expect(checkRules('string', { ...emptyRulesForm(), pattern: '(a+)+' }).pattern).toBe(
			'pattern_unsafe'
		);
		expect(checkRules('number', { ...emptyRulesForm(), min: 'abc' }).min).toBe('min_invalid');
		expect(checkRules('number', { ...emptyRulesForm(), min: '9', max: '3' }).max).toBe(
			'range_order'
		);
		expect(checkRules('string', emptyRulesForm())).toEqual({});
	});

	it('wants an enum to have values, without repeats, up to 100', () => {
		expect(checkRules('enum', emptyRulesForm()).enumValues).toBe('enum_empty');
		expect(checkRules('enum', { ...emptyRulesForm(), enumValues: ['a', 'a'] }).enumValues).toBe(
			'enum_duplicate'
		);
		const many = Array.from({ length: 101 }, (_, index) => `v${index}`);
		expect(checkRules('enum', { ...emptyRulesForm(), enumValues: many }).enumValues).toBe(
			'enum_too_many'
		);
		expect(checkRules('enum', { ...emptyRulesForm(), enumValues: ['a', 'b'] })).toEqual({});
	});

	it('checks the order of two dates', () => {
		expect(
			checkRules('date', { ...emptyRulesForm(), minDate: '2026-02-01', maxDate: '2026-01-01' })
				.maxDate
		).toBe('date_order');
	});
});
