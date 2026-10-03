/**
 * The text colour for a tenant's accent colour: near-black or white, whichever reads better on it
 * (WCAG contrast). A primary button filled with the accent uses it, so any accent keeps its label
 * readable. Null when the colour is not one `sanitizeColor` accepts.
 */

const DARK = '#111111';
const LIGHT = '#ffffff';

type Rgb = [number, number, number];

function parse(color: string): Rgb | null {
	const value = color.trim();
	const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (hex) {
		const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
		return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
	}
	const rgb = value.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
	const hsl = value.match(/^hsla?\(\s*(\d{1,3})\s*,\s*(\d{1,3})%\s*,\s*(\d{1,3})%/i);
	if (hsl) return fromHsl(Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100);
	return null;
}

function fromHsl(h: number, s: number, l: number): Rgb {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
	return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function accentTextColor(color: string | null | undefined): string | null {
	const rgb = color ? parse(color) : null;
	if (!rgb) return null;
	const l = luminance(rgb);
	const onDark = (1 + 0.05) / (l + 0.05);
	const onLight = (l + 0.05) / (luminance(parse(DARK)!) + 0.05);
	return onLight >= onDark ? DARK : LIGHT;
}
