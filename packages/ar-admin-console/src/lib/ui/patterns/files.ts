/**
 * Mirrors the browser's `accept` rules so dropped files get the same check as picked files
 * (drag and drop bypasses the file dialog's filter).
 */
export function matchesAccept(
	file: { name: string; type: string },
	accept: string | undefined
): boolean {
	if (!accept) return true;
	const name = file.name.toLowerCase();
	const type = file.type.toLowerCase();
	return accept
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean)
		.some((token) => {
			if (token.startsWith('.')) return name.endsWith(token);
			if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
			return type === token;
		});
}

export type FileRejection = { name: string; reason: 'type' | 'size' };

export function partitionFiles<T extends { name: string; type: string; size: number }>(
	files: readonly T[],
	options: { accept?: string; maxBytes?: number }
): { accepted: T[]; rejected: FileRejection[] } {
	const accepted: T[] = [];
	const rejected: FileRejection[] = [];
	for (const file of files) {
		if (!matchesAccept(file, options.accept)) rejected.push({ name: file.name, reason: 'type' });
		else if (options.maxBytes !== undefined && file.size > options.maxBytes)
			rejected.push({ name: file.name, reason: 'size' });
		else accepted.push(file);
	}
	return { accepted, rejected };
}

/** Readable list of accepted types for hints: ".json, image/*" → "JSON, IMAGE". */
export function describeAccept(accept: string | undefined): string {
	if (!accept) return '';
	return accept
		.split(',')
		.map((token) =>
			token
				.trim()
				.replace(/^\./, '')
				.replace(/\/\*$/, '')
				.replace(/^.*\//, '')
				.replace(/\+xml$/, '')
		)
		.filter(Boolean)
		.map((token) => token.toUpperCase())
		.join(', ');
}
