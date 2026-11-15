import { describe, expect, it } from 'vitest';
import { CSV_HEADERS } from '#lib/api/identifier-materials.js';
import { columnsOf, isHeaderOnly, rowErrorKey, sortedRowErrors } from './identifier-import-model';

describe('isHeaderOnly', () => {
	it('is true for the header alone, with or without a line break after it', () => {
		expect(isHeaderOnly('account,audience,action,salt')).toBe(true);
		expect(isHeaderOnly('account,audience,action,salt\n')).toBe(true);
		expect(isHeaderOnly('account,audience,action,salt\r\n\r\n')).toBe(true);
	});

	it('is false once a row follows the header', () => {
		expect(isHeaderOnly('account,audience,action,salt\nusr_1,*,block,')).toBe(false);
	});
});

describe('rowErrorKey', () => {
	it('has a message for each reason the API gives, and none for an unknown one', () => {
		expect(rowErrorKey('unknown_account')).toBe('pid.rowError.unknown_account');
		expect(rowErrorKey('something_new')).toBeNull();
	});
});

describe('columns', () => {
	it('match the header the API expects', () => {
		for (const kind of ['source', 'store', 'exceptions'] as const) {
			expect(columnsOf(kind).join(',')).toBe(CSV_HEADERS[kind]);
		}
	});

	it('lists refused rows in file order', () => {
		const sorted = sortedRowErrors([
			{ row: 5, column: 'account', code: 'x' },
			{ row: 2, column: 'value', code: 'y' }
		]);
		expect(sorted.map((error) => error.row)).toEqual([2, 5]);
	});
});
