/**
 * Page layout for the screen builder: rows of one to three columns, each column a list of
 * parts. Every part lives in a row, so "two columns" is a property of the row the admin can
 * see and change, not a hidden marker between parts. All functions return new rows and never
 * lose a part: fewer columns move the parts of the removed columns into the last one kept.
 */
export interface LayoutPart {
	id: string;
	/** Part type, e.g. "heading", "auth_widget". */
	kind: string;
	/** The name shown to users (may be empty, e.g. a divider without text). */
	label: string;
}

export interface LayoutRow {
	id: string;
	columns: LayoutPart[][];
}

export const MAX_COLUMNS = 3;

/** Where a part goes: into a column at an index, or as a new one-column row. */
export type DropTarget =
	| { kind: 'column'; rowId: string; column: number; index: number }
	| { kind: 'row'; index: number };

export interface PartPlace {
	row: number;
	column: number;
	index: number;
}

export function findPart(rows: readonly LayoutRow[], id: string): PartPlace | null {
	for (let row = 0; row < rows.length; row++) {
		const columns = rows[row].columns;
		for (let column = 0; column < columns.length; column++) {
			const index = columns[column].findIndex((part) => part.id === id);
			if (index >= 0) return { row, column, index };
		}
	}
	return null;
}

const copy = (rows: readonly LayoutRow[]): LayoutRow[] =>
	rows.map((row) => ({ ...row, columns: row.columns.map((column) => [...column]) }));

/** A one-column row left with nothing in it has no reason to stay. */
const tidy = (rows: LayoutRow[]): LayoutRow[] =>
	rows.filter((row) => row.columns.length > 1 || row.columns[0].length > 0);

export function removePart(rows: readonly LayoutRow[], id: string): LayoutRow[] {
	const place = findPart(rows, id);
	if (!place) return copy(rows);
	const next = copy(rows);
	next[place.row].columns[place.column].splice(place.index, 1);
	return tidy(next);
}

export function insertPart(
	rows: readonly LayoutRow[],
	part: LayoutPart,
	target: DropTarget,
	newRowId: () => string
): LayoutRow[] {
	const next = copy(rows);
	if (target.kind === 'row') {
		const index = Math.max(0, Math.min(target.index, next.length));
		next.splice(index, 0, { id: newRowId(), columns: [[part]] });
		return next;
	}
	const row = next.find((candidate) => candidate.id === target.rowId);
	if (!row) return [...next, { id: newRowId(), columns: [[part]] }];
	const column = row.columns[Math.max(0, Math.min(target.column, row.columns.length - 1))];
	column.splice(Math.max(0, Math.min(target.index, column.length)), 0, part);
	return next;
}

/** Move a part; `target` is read against the layout as it is before the move. */
export function movePart(
	rows: readonly LayoutRow[],
	id: string,
	target: DropTarget,
	newRowId: () => string
): LayoutRow[] {
	const place = findPart(rows, id);
	if (!place) return copy(rows);
	const from = rows[place.row];
	const part = from.columns[place.column][place.index];
	let adjusted: DropTarget = target;
	if (target.kind === 'column') {
		// Taking the part out first shifts the later slots of its own column up by one.
		if (from.id === target.rowId && place.column === target.column && target.index > place.index) {
			adjusted = { ...target, index: target.index - 1 };
		}
	} else if (
		from.columns.length === 1 &&
		from.columns[0].length === 1 &&
		target.index > place.row
	) {
		// Its own row disappears once emptied, which shifts the rows after it up by one.
		adjusted = { ...target, index: target.index - 1 };
	}
	const removed = removePart(rows, id);
	if (adjusted.kind === 'column') {
		const rowId = adjusted.rowId;
		// Dropped back into its own row that just disappeared: keep it where it was.
		if (!removed.some((row) => row.id === rowId)) {
			return insertPart(removed, part, { kind: 'row', index: place.row }, newRowId);
		}
	}
	return insertPart(removed, part, adjusted, newRowId);
}

/** Change a row's column count. Parts of removed columns join the last column kept. */
export function setColumns(rows: readonly LayoutRow[], rowId: string, count: number): LayoutRow[] {
	const wanted = Math.max(1, Math.min(MAX_COLUMNS, Math.round(count)));
	return copy(rows).map((row) => {
		if (row.id !== rowId || row.columns.length === wanted) return row;
		if (wanted > row.columns.length) {
			const added = Array.from({ length: wanted - row.columns.length }, (): LayoutPart[] => []);
			return { ...row, columns: [...row.columns, ...added] };
		}
		const kept = row.columns.slice(0, wanted);
		kept[wanted - 1] = [...kept[wanted - 1], ...row.columns.slice(wanted).flat()];
		return { ...row, columns: kept };
	});
}

export function moveRow(rows: readonly LayoutRow[], rowId: string, toIndex: number): LayoutRow[] {
	const next = copy(rows);
	const from = next.findIndex((row) => row.id === rowId);
	if (from < 0) return next;
	const [row] = next.splice(from, 1);
	next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, row);
	return next;
}

/** Remove a row; its parts are removed with it (the page asks first when it has any). */
export function removeRow(rows: readonly LayoutRow[], rowId: string): LayoutRow[] {
	return copy(rows).filter((row) => row.id !== rowId);
}

/**
 * Keyboard moves (Alt + arrow). Up/down move within the column and on into the row above or
 * below (at the ends, out into a row of its own); left/right move to the neighbouring column.
 */
export function stepPart(
	rows: readonly LayoutRow[],
	id: string,
	direction: 'up' | 'down' | 'left' | 'right',
	newRowId: () => string
): LayoutRow[] {
	const place = findPart(rows, id);
	if (!place) return copy(rows);
	const row = rows[place.row];
	const column = row.columns[place.column];
	const inColumn = (columnIndex: number, index: number): DropTarget => ({
		kind: 'column',
		rowId: row.id,
		column: columnIndex,
		index
	});

	if (direction === 'left' || direction === 'right') {
		const to = place.column + (direction === 'left' ? -1 : 1);
		if (to < 0 || to >= row.columns.length) return copy(rows);
		return movePart(
			rows,
			id,
			inColumn(to, Math.min(place.index, row.columns[to].length)),
			newRowId
		);
	}
	if (direction === 'up' && place.index > 0) {
		return movePart(rows, id, inColumn(place.column, place.index - 1), newRowId);
	}
	if (direction === 'down' && place.index < column.length - 1) {
		return movePart(rows, id, inColumn(place.column, place.index + 2), newRowId);
	}

	const alone = row.columns.length === 1 && column.length === 1;
	if (direction === 'up') {
		if (place.row === 0) {
			return alone ? copy(rows) : movePart(rows, id, { kind: 'row', index: 0 }, newRowId);
		}
		const above = rows[place.row - 1];
		const to = Math.min(place.column, above.columns.length - 1);
		const target: DropTarget = {
			kind: 'column',
			rowId: above.id,
			column: to,
			index: above.columns[to].length
		};
		return movePart(rows, id, target, newRowId);
	}
	if (place.row === rows.length - 1) {
		return alone ? copy(rows) : movePart(rows, id, { kind: 'row', index: rows.length }, newRowId);
	}
	const below = rows[place.row + 1];
	const to = Math.min(place.column, below.columns.length - 1);
	return movePart(rows, id, { kind: 'column', rowId: below.id, column: to, index: 0 }, newRowId);
}
