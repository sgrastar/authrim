/**
 * Tenant accent colours, as the Login UI applies them (kept in step with
 * ar-login-ui/src/lib/utils/accent-text.ts, so the theme preview matches the login pages): always opaque `#rrggbb`, with the label
 * colour that reads on them.
 *
 * An accent fills primary buttons, so it must be one colour every renderer resolves the same way
 * (server and browser) and that the label can be chosen against: `#rgb`, `#rrggbb` or rgb()/rgba(),
 * applied opaque (an alpha is dropped). Anything else (a named colour, hsl(), 8-digit hex) is not
 * applied and the theme's own accent is used.
 */

type Rgb = [number, number, number];

function parse(color: string): Rgb | null {
	const value = color.trim();
	// Only what every step lets through: the authentication-methods API (hex, rgb()), the Login
	// UI's sanitizeColor (each channel and the alpha checked) and this parser.
	const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
		return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
	}
	const rgb = value.match(
		/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d+))?\s*\)$/i
	);
	if (rgb) {
		const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
		return channels.every((c) => c <= 255) ? (channels as Rgb) : null;
	}
	return null;
}

function luminance([r, g, b]: Rgb): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The accent as applied: opaque `#rrggbb`, or null when it is not a colour Authrim applies. */
export function normalizeAccentColor(color: string | null | undefined): string | null {
	const rgb = color ? parse(color) : null;
	if (!rgb) return null;
	return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The label colour for an accent: black or white, whichever has the higher contrast. One of the two
 * always reaches at least 4.58:1 on an opaque colour. Null when the accent is not applied.
 */
export function accentTextColor(color: string | null | undefined): string | null {
	const normalized = normalizeAccentColor(color);
	if (!normalized) return null;
	const l = luminance(parse(normalized)!);
	const onWhite = 1.05 / (l + 0.05);
	const onBlack = (l + 0.05) / 0.05;
	return onBlack >= onWhite ? '#000000' : '#ffffff';
}
