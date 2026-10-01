import { describe, expect, it } from 'vitest';
import { checkJson, findJsonError, formatJson } from './json';

describe('checkJson', () => {
	it('treats blank input as empty rather than invalid', () => {
		expect(checkJson('  \n')).toEqual({ state: 'empty' });
	});

	it('returns the parsed value', () => {
		expect(checkJson('{"a":[1,2]}')).toEqual({ state: 'valid', value: { a: [1, 2] } });
	});

	it('points at the first error, even when the engine message has no position', () => {
		expect(checkJson('{\n  "a": 1,\n  "b": }')).toEqual({ state: 'invalid', line: 3, column: 8 });
		expect(checkJson('[1,2,]')).toEqual({ state: 'invalid', line: 1, column: 6 });
		expect(checkJson('{"a":')).toEqual({ state: 'invalid', line: 1, column: 6 });
	});
});

describe('findJsonError', () => {
	it('agrees with JSON.parse on what is valid', () => {
		const samples = [
			'{"a":{"b":[true,false,null,-1.5e3,"x\\u00e9\\n"]}}',
			'  [ ]  ',
			'"text"',
			'0',
			'01',
			'{"a" 1}',
			'{"a":1,}',
			'tru',
			'"bad \\q escape"',
			'[1] 2',
			'-'
		];
		for (const sample of samples) {
			let valid = true;
			try {
				JSON.parse(sample);
			} catch {
				valid = false;
			}
			expect(findJsonError(sample) === -1, sample).toBe(valid);
		}
	});
});

describe('formatJson', () => {
	it('indents valid JSON and keeps invalid text as typed', () => {
		expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}\n');
		expect(formatJson('{"a":')).toBe('{"a":');
	});
});
