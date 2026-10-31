import { describe, expect, it } from 'vitest';
import { duplicateIndexes, splitLines } from './list-input';

describe('splitLines', () => {
	it('splits pasted lines, trimming and dropping empty ones', () => {
		expect(splitLines('https://a.example\r\n\n  https://b.example  \n')).toEqual([
			'https://a.example',
			'https://b.example'
		]);
	});
});

describe('duplicateIndexes', () => {
	it('flags later repeats only, ignoring empty entries and surrounding spaces', () => {
		expect([...duplicateIndexes(['a', 'b', ' a', '', '', 'b'])]).toEqual([2, 5]);
	});
});
