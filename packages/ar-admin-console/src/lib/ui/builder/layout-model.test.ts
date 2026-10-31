import { describe, expect, it } from 'vitest';
import {
	findPart,
	insertPart,
	movePart,
	moveRow,
	removePart,
	setColumns,
	stepPart,
	type LayoutRow
} from './layout-model';

const part = (id: string) => ({ id, kind: 'text', label: id });
let counter = 0;
const newRowId = () => `new-${++counter}`;
const shape = (rows: LayoutRow[]) =>
	rows.map((row) => row.columns.map((column) => column.map((p) => p.id)));

const layout = (): LayoutRow[] => [
	{ id: 'r1', columns: [[part('title')]] },
	{ id: 'r2', columns: [[part('a'), part('b')], [part('c')]] },
	{ id: 'r3', columns: [[part('footer')]] }
];

describe('layout model', () => {
	it('finds a part', () => {
		expect(findPart(layout(), 'c')).toEqual({ row: 1, column: 1, index: 0 });
	});

	it('moves a part down within its column, counting slots before the move', () => {
		const target = { kind: 'column', rowId: 'r2', column: 0, index: 2 } as const;
		expect(shape(movePart(layout(), 'a', target, newRowId))[1]).toEqual([['b', 'a'], ['c']]);
	});

	it('moves a part into another column', () => {
		const target = { kind: 'column', rowId: 'r2', column: 1, index: 1 } as const;
		expect(shape(movePart(layout(), 'a', target, newRowId))[1]).toEqual([['b'], ['c', 'a']]);
	});

	it('drops a part between rows as a new one-column row, and drops its emptied row', () => {
		const rows = movePart(layout(), 'title', { kind: 'row', index: 3 }, newRowId);
		expect(shape(rows)).toEqual([[['a', 'b'], ['c']], [['footer']], [['title']]]);
	});

	it('keeps a multi-column row when a column empties', () => {
		expect(shape(removePart(layout(), 'c'))[1]).toEqual([['a', 'b'], []]);
	});

	it('adds columns empty and merges removed columns into the last one kept', () => {
		expect(shape(setColumns(layout(), 'r1', 3))[0]).toEqual([['title'], [], []]);
		expect(shape(setColumns(layout(), 'r2', 1))[1]).toEqual([['a', 'b', 'c']]);
	});

	it('inserts a new part as a row or into a column', () => {
		const asRow = insertPart(layout(), part('x'), { kind: 'row', index: 0 }, newRowId);
		expect(shape(asRow)[0]).toEqual([['x']]);
		const target = { kind: 'column', rowId: 'r2', column: 1, index: 0 } as const;
		expect(shape(insertPart(layout(), part('x'), target, newRowId))[1]).toEqual([
			['a', 'b'],
			['x', 'c']
		]);
	});

	it('moves rows', () => {
		expect(moveRow(layout(), 'r3', 0).map((row) => row.id)).toEqual(['r3', 'r1', 'r2']);
	});

	it('steps with the keyboard: within a column, across columns and into the next row', () => {
		expect(shape(stepPart(layout(), 'a', 'down', newRowId))[1]).toEqual([['b', 'a'], ['c']]);
		expect(shape(stepPart(layout(), 'b', 'right', newRowId))[1]).toEqual([['a'], ['c', 'b']]);
		expect(shape(stepPart(layout(), 'b', 'down', newRowId))[2]).toEqual([['b', 'footer']]);
		expect(shape(stepPart(layout(), 'title', 'up', newRowId))).toEqual(shape(layout()));
	});
});
