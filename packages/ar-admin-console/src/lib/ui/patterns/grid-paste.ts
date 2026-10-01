/** Pasting a block copied from a spreadsheet (tab-separated rows) into an editable table. */

export interface PasteColumn {
	key: string;
	kind: 'text' | 'select' | 'checkbox';
	options?: readonly { value: string; label: string }[];
}

/** Rows of cells from tab-separated text; a trailing empty line is dropped. */
export function parseGrid(text: string): string[][] {
	const lines = text.replace(/\r\n?/g, '\n').split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines.map((line) => line.split('\t'));
}

/** Whether pasted text is more than one cell. */
export const isBlock = (text: string) => /[\t\n]/.test(text.replace(/\r?\n$/, ''));

const TRUE = new Set(['true', '1', 'yes', 'y', 'on', 'x', '✓', '✔', 'はい', '○', '◯', 'ja', 'نعم']);

function cellValue(column: PasteColumn, raw: string, current: unknown): unknown {
	const text = raw.trim();
	if (column.kind === 'checkbox') return TRUE.has(text.toLowerCase());
	if (column.kind === 'select') {
		const match = column.options?.find(
			(option) =>
				option.value.toLowerCase() === text.toLowerCase() ||
				option.label.toLowerCase() === text.toLowerCase()
		);
		return match ? match.value : current;
	}
	return text;
}

/**
 * Fills cells from (row, column) onward, adding rows at the end as needed. Values that do
 * not fit a select column keep what was there. Returns the new rows.
 */
export function pasteIntoRows<T extends Record<string, unknown>>(
	rows: readonly T[],
	start: { row: number; column: number },
	columns: readonly PasteColumn[],
	grid: readonly string[][],
	makeRow: () => T
): T[] {
	const next = rows.map((row) => ({ ...row }));
	grid.forEach((cells, r) => {
		const index = start.row + r;
		while (next.length <= index) next.push(makeRow());
		cells.forEach((raw, c) => {
			const column = columns[start.column + c];
			if (!column) return;
			(next[index] as Record<string, unknown>)[column.key] = cellValue(
				column,
				raw,
				next[index][column.key]
			);
		});
	});
	return next;
}
