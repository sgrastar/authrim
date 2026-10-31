/**
 * Numbers shown to people: grouped the local way ("1,234" / "1.234"), always in Latin digits
 * (identifiers, codes and logs around them are Latin too, including in Arabic).
 */
export function formatNumber(
	value: number,
	locale: string,
	options: Intl.NumberFormatOptions = {}
): string {
	return new Intl.NumberFormat(locale, { numberingSystem: 'latn', ...options }).format(value);
}

/** Human-readable byte size in the given locale, e.g. "2.4 MB" / "2,4 MB". */
export function formatBytes(bytes: number, locale: string): string {
	const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return formatNumber(value, locale, {
		style: 'unit',
		unit: units[unit],
		// Bytes read better as "27 B" than "27 byte"; larger units keep their short form.
		unitDisplay: unit === 0 ? 'narrow' : 'short',
		maximumFractionDigits: unit === 0 ? 0 : 1
	});
}
