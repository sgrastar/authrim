/** Helpers for editing lists of values (ListField, KeyValueField). */

/** Lines of pasted text, trimmed, without empty ones. */
export function splitLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Indexes of entries whose (trimmed) value appeared earlier in the list; empty ones never count. */
export function duplicateIndexes(values: readonly string[]): Set<number> {
	const seen = new Set<string>();
	const repeated = new Set<number>();
	values.forEach((raw, index) => {
		const value = raw.trim();
		if (!value) return;
		if (seen.has(value)) repeated.add(index);
		seen.add(value);
	});
	return repeated;
}
