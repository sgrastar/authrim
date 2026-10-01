import { describe, expect, it } from 'vitest';
import { sortRows } from './table-sort';

const rows = [
	{ name: 'item 10', count: 3 },
	{ name: 'Item 2', count: null },
	{ name: 'item 1', count: 7 }
];
const value = (row: (typeof rows)[number], key: string) => row[key as keyof typeof row];

describe('sortRows', () => {
	it('keeps order without a sort', () => {
		expect(sortRows(rows, null, value, 'en')).toEqual(rows);
	});

	it('sorts strings numerically and case-insensitively', () => {
		const names = sortRows(rows, { key: 'name', direction: 'asc' }, value, 'en').map((r) => r.name);
		expect(names).toEqual(['item 1', 'Item 2', 'item 10']);
	});

	it('reverses for descending and keeps missing values last', () => {
		const counts = sortRows(rows, { key: 'count', direction: 'desc' }, value, 'en').map(
			(r) => r.count
		);
		expect(counts).toEqual([7, 3, null]);
	});
});
