import { describe, expect, it } from 'vitest';
import { importConflictOf } from './identifier-materials';

describe('importConflictOf', () => {
	it('reads the count of others’ values under the name each kind uses', () => {
		expect(importConflictOf('source', { conflicts: 1, valuesOfOthers: 2 })).toEqual({
			conflicts: 1,
			valuesOfOthers: 2
		});
		expect(importConflictOf('store', { conflicts: 0, identifiersOfOthers: 3 })).toEqual({
			conflicts: 0,
			valuesOfOthers: 3
		});
		expect(importConflictOf('store', { valuesOfOthers: 3 }).valuesOfOthers).toBe(0);
	});
});
