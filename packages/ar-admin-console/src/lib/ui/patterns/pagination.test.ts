import { describe, expect, it } from 'vitest';
import { pageItems } from './pagination';

describe('pageItems', () => {
	it('lists every page when they fit', () => {
		expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(pageItems(1, 0)).toEqual([]);
	});

	it('keeps first, last and the pages around the current one', () => {
		expect(pageItems(1, 20)).toEqual([1, 2, 3, 4, 5, 'gap', 20]);
		expect(pageItems(10, 20)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
		expect(pageItems(20, 20)).toEqual([1, 'gap', 16, 17, 18, 19, 20]);
	});

	it('always shows the same number of buttons while paging', () => {
		const lengths = new Set(Array.from({ length: 20 }, (_, i) => pageItems(i + 1, 20).length));
		expect([...lengths]).toEqual([7]);
	});

	it('clamps an out-of-range current page', () => {
		expect(pageItems(99, 20)).toEqual(pageItems(20, 20));
	});
});
