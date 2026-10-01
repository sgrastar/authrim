import { describe, expect, it } from 'vitest';
import { isBlock, parseGrid, pasteIntoRows, type PasteColumn } from './grid-paste';

const columns: PasteColumn[] = [
	{ key: 'path', kind: 'text' },
	{
		key: 'type',
		kind: 'select',
		options: [
			{ value: 'string', label: 'Text' },
			{ value: 'boolean', label: 'Yes/no' }
		]
	},
	{ key: 'required', kind: 'checkbox' }
];
const blank = () => ({ path: '', type: 'string', required: false });

describe('parseGrid', () => {
	it('reads tab-separated rows and drops the trailing line break', () => {
		expect(parseGrid('a\tb\r\nc\td\n')).toEqual([
			['a', 'b'],
			['c', 'd']
		]);
		expect(isBlock('one cell\n')).toBe(false);
		expect(isBlock('a\tb')).toBe(true);
	});
});

describe('pasteIntoRows', () => {
	it('fills from the focused cell, converts values and adds rows', () => {
		const rows = [{ path: 'email', type: 'string', required: true }];
		const grid = parseGrid('email\tText\tyes\nactive\tboolean\t0\ndisplay\tunknown\tはい');
		expect(pasteIntoRows(rows, { row: 0, column: 0 }, columns, grid, blank)).toEqual([
			{ path: 'email', type: 'string', required: true },
			{ path: 'active', type: 'boolean', required: false },
			// A value that is not an option keeps the default.
			{ path: 'display', type: 'string', required: true }
		]);
	});

	it('ignores cells beyond the last column', () => {
		const out = pasteIntoRows([blank()], { row: 0, column: 2 }, columns, [['yes', 'extra']], blank);
		expect(out[0].required).toBe(true);
	});
});
