export type PageItem = number | 'gap';

/**
 * Page buttons to show: always the first and last page, the current page with `siblings` on
 * each side, and a gap where pages are skipped. A gap never hides a single page (it would be
 * shorter to show the page itself), so the number of buttons stays stable while paging.
 */
export function pageItems(current: number, pageCount: number, siblings = 1): PageItem[] {
	if (pageCount <= 0) return [];
	const slots = siblings * 2 + 5; // first, last, current, siblings, two gaps
	if (pageCount <= slots) return Array.from({ length: pageCount }, (_, i) => i + 1);

	const page = Math.min(Math.max(current, 1), pageCount);
	const start = Math.max(2, Math.min(page - siblings, pageCount - siblings * 2 - 2));
	const end = Math.min(pageCount - 1, Math.max(page + siblings, siblings * 2 + 3));

	const items: PageItem[] = [1];
	items.push(start > 2 ? 'gap' : 2);
	for (let n = Math.max(start, 3); n <= Math.min(end, pageCount - 2); n++) items.push(n);
	items.push(end < pageCount - 1 ? 'gap' : pageCount - 1);
	items.push(pageCount);
	return items;
}
