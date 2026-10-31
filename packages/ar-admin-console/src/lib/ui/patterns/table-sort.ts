import type { SortState } from './DataTable.svelte';

/**
 * Client-side sort for tables whose rows are all loaded. Server-paginated tables pass the sort
 * state to the API instead. Strings compare with the locale's collation (numeric-aware, so
 * "item 2" < "item 10"); missing values sort last.
 */
export function sortRows<Row>(
	rows: readonly Row[],
	sort: SortState | null | undefined,
	value: (row: Row, key: string) => string | number | null | undefined,
	locale: string
): Row[] {
	if (!sort) return [...rows];
	const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
	const sign = sort.direction === 'asc' ? 1 : -1;
	return [...rows].sort((a, b) => {
		const x = value(a, sort.key);
		const y = value(b, sort.key);
		if (x == null && y == null) return 0;
		if (x == null) return 1;
		if (y == null) return -1;
		const order =
			typeof x === 'number' && typeof y === 'number'
				? x - y
				: collator.compare(String(x), String(y));
		return order * sign;
	});
}
