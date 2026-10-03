import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Text contrast of every built-in theme, scheme and variant, read from the stylesheets.
 *
 * The Storybook a11y check cannot judge text on a translucent card over imagery (axe reports it as
 * incomplete, not as a violation), so the tokens are checked here: each card colour is composited
 * over what shows through it, and the text tokens must meet WCAG AA (4.5:1) on the result.
 */

const themes = readFileSync(new URL('../lib/styles/themes.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

type Rgb = [number, number, number];
interface Colour {
	rgb: Rgb;
	alpha: number;
}

/** The custom properties of the rule whose selector starts a line with `selector`. */
function tokens(css: string, selector: string): Record<string, string> {
	const at = css.indexOf(`\n${selector}`);
	if (at < 0) throw new Error(`No rule for ${selector}`);
	const open = css.indexOf('{', at);
	const close = css.indexOf('}', open);
	const result: Record<string, string> = {};
	for (const match of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
		result[match[1]] = match[2].trim();
	}
	return result;
}

function colour(value: string): Colour {
	// A tenant-overridable colour: its built-in fallback.
	const fallback = value.match(/^var\(--[\w-]+,\s*(.+)\)$/);
	if (fallback) return colour(fallback[1]);
	const hex = value.match(/^#([0-9a-f]{6})$/i);
	if (hex) {
		const n = hex[1];
		return { rgb: [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as Rgb, alpha: 1 };
	}
	const rgba = value.match(/^rgba?\(([^)]+)\)$/);
	if (rgba) {
		const [r, g, b, a = 1] = rgba[1].split(',').map((part) => Number(part.trim()));
		return { rgb: [r, g, b], alpha: a };
	}
	throw new Error(`Not a literal colour: ${value}`);
}

function over(top: Colour, bottom: Rgb): Rgb {
	return top.rgb.map((value, i) => value * top.alpha + bottom[i] * (1 - top.alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
	const channel = (value: number) => {
		const v = value / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light + 0.05) / (dark + 0.05);
}

/** The colour stops of the default imagery a fullbleed page shows through its card. */
function imageryStops(selector: string): Rgb[] {
	const at = app.indexOf(`\n${selector}`);
	const rule = app.slice(at, app.indexOf('}', at));
	const gradient = rule.match(/linear-gradient\(160deg,[^)]+\)/)?.[0] ?? '';
	return [...gradient.matchAll(/#[0-9a-f]{6}/gi)].map((m) => colour(m[0]).rgb);
}

interface Case {
	name: string;
	values: Record<string, string>;
	/** What shows through the card: the page colour, or each stop of the imagery under its scrim. */
	behind: Rgb[];
}

const BOUNDARY = ':is(:root, .login-ui-theme-boundary)';
const classic = (selector: string) => tokens(themes, selector);
const page = (values: Record<string, string>) => [colour(values['--bg-page']).rgb];

const meridianLight = tokens(app, `${BOUNDARY}[data-login-theme='meridian'],`);
const meridianDark = tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='meridian'],`);
const glassDark = tokens(app, `${BOUNDARY}[data-login-theme='fullbleed-glass'] {`);
const glassLight = {
	...glassDark,
	...tokens(app, `${BOUNDARY}[data-theme='light'][data-login-theme='fullbleed-glass'] {`)
};
// The full-page scrims over the imagery (the last layer of each page's overlay).
const glassDarkScrim = colour('rgba(8, 5, 4, 0.5)');
const glassLightScrim = colour('rgba(20, 12, 8, 0.12)');

const lightBeige = classic(":root,\n[data-theme='light'],");
const lightBlueGray = classic("[data-theme='light'][data-variant='blue-gray'] {");
const lightGreen = classic("[data-theme='light'][data-variant='green'] {");
const darkBrown = classic("[data-theme='dark'],\n[data-theme='dark'][data-variant='brown'] {");
const darkNavy = classic("[data-theme='dark'][data-variant='navy'] {");
const darkSlate = classic("[data-theme='dark'][data-variant='slate'] {");

const CASES: Case[] = [
	{ name: 'classic light beige', values: lightBeige, behind: page(lightBeige) },
	{ name: 'classic light blue-gray', values: lightBlueGray, behind: page(lightBlueGray) },
	{ name: 'classic light green', values: lightGreen, behind: page(lightGreen) },
	{ name: 'classic dark brown', values: darkBrown, behind: page(darkBrown) },
	{ name: 'classic dark navy', values: darkNavy, behind: page(darkNavy) },
	{ name: 'classic dark slate', values: darkSlate, behind: page(darkSlate) },
	{ name: 'meridian / split light', values: meridianLight, behind: page(meridianLight) },
	{ name: 'meridian / split dark', values: meridianDark, behind: page(meridianDark) },
	{
		name: 'fullbleed glass dark',
		values: glassDark,
		behind: imageryStops("[data-login-theme='fullbleed-glass'] .auth-page {").map((stop) =>
			over(glassDarkScrim, stop)
		)
	},
	{
		name: 'fullbleed glass light',
		values: glassLight,
		behind: imageryStops(
			"[data-theme='light'][data-login-theme='fullbleed-glass'] .auth-page {"
		).map((stop) => over(glassLightScrim, stop))
	}
];

describe('theme contrast', () => {
	it.each(CASES)('$name: text on the card meets AA', ({ values, behind }) => {
		expect(behind.length).toBeGreaterThan(0);
		for (const under of behind) {
			const card = over(colour(values['--bg-card']), under);
			for (const token of ['--text-primary', '--text-secondary', '--text-muted', '--primary']) {
				const ratio = contrast(colour(values[token]).rgb, card);
				expect(
					ratio,
					`${token} ${values[token]} on ${card.map(Math.round)}`
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it.each([
		{ name: 'meridian / split light', values: meridianLight },
		{ name: 'meridian / split dark', values: meridianDark },
		{ name: 'fullbleed glass dark', values: glassDark },
		{ name: 'fullbleed glass light', values: glassLight }
	])('$name: primary button text meets AA', ({ values }) => {
		const background = colour(
			values['--button-primary-bg'] === 'var(--primary)'
				? values['--primary']
				: values['--button-primary-bg']
		).rgb;
		expect(
			contrast(colour(values['--button-primary-text']).rgb, background)
		).toBeGreaterThanOrEqual(4.5);
	});
});
