/** Colours as typed by people (hex), and how readable text is on them (WCAG contrast). */

/** "#abc", "ABC", "#AABBCC" → "#aabbcc"; anything else → null. */
export function normalizeHex(text: string): string | null {
	const raw = text.trim().replace(/^#/, '').toLowerCase();
	if (/^[0-9a-f]{3}$/.test(raw)) return `#${[...raw].map((c) => c + c).join('')}`;
	if (/^[0-9a-f]{6}$/.test(raw)) return `#${raw}`;
	return null;
}

function luminance(hex: string): number {
	const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two normalized hex colours (1–21). */
export function contrastRatio(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}
