/**
 * Which tabs fit in `room` px, the rest going under "More" (`more` px wide). The current tab
 * always stays in the row: if it would fall under "More", it takes the place of the last
 * tabs that fit. Order is kept in both groups.
 */
export function splitTabs<T extends { id: string }>(
	items: readonly T[],
	widths: readonly number[],
	room: number,
	more: number,
	current: string
): { shown: T[]; more: T[] } {
	const total = widths.reduce((sum, width) => sum + width, 0);
	// Not measured yet (first frame): show everything rather than hide it all under "More".
	if (items.length === 0 || room <= 0 || total <= room) return { shown: [...items], more: [] };
	const space = room - more;
	const width = (item: T) => widths[items.indexOf(item)] ?? 0;
	const shown: T[] = [];
	let used = 0;
	for (const item of items) {
		if (used + width(item) > space) break;
		shown.push(item);
		used += width(item);
	}
	const active = items.find((item) => item.id === current);
	if (active && !shown.includes(active)) {
		while (shown.length > 0 && used + width(active) > space) used -= width(shown.pop()!);
		shown.push(active);
	}
	const kept = new Set(shown);
	return {
		shown: items.filter((item) => kept.has(item)),
		more: items.filter((item) => !kept.has(item))
	};
}
