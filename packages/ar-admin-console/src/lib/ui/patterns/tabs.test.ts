import { describe, expect, it } from 'vitest';
import { splitTabs } from './tabs';

const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
const widths = [100, 100, 100, 100, 100];
const ids = (list: { id: string }[]) => list.map((item) => item.id);

describe('splitTabs', () => {
	it('shows every tab when they fit', () => {
		const { shown, more } = splitTabs(items, widths, 500, 60, 'a');
		expect(ids(shown)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(more).toEqual([]);
	});

	it('moves the tabs that do not fit under More, keeping room for the More button', () => {
		const { shown, more } = splitTabs(items, widths, 360, 60, 'a');
		expect(ids(shown)).toEqual(['a', 'b', 'c']);
		expect(ids(more)).toEqual(['d', 'e']);
	});

	it('keeps the current tab in the row, in its place in the order', () => {
		const { shown, more } = splitTabs(items, widths, 360, 60, 'e');
		expect(ids(shown)).toEqual(['a', 'b', 'e']);
		expect(ids(more)).toEqual(['c', 'd']);
	});

	it('makes room for a wide current tab by moving more tabs out', () => {
		const { shown } = splitTabs(items, [100, 100, 100, 100, 180], 360, 60, 'e');
		expect(ids(shown)).toEqual(['a', 'e']);
	});

	it('shows every tab until the row has been measured', () => {
		expect(ids(splitTabs(items, widths, 0, 60, 'a').shown)).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});
