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
const alert = readFileSync(new URL('../lib/components/Alert.svelte', import.meta.url), 'utf8');

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

/**
 * A colour as a theme declares it: a literal, a variable of the theme (resolved in `values`, then
 * the shared tokens), or `color-mix(in srgb, X p%, transparent)` (X at p% opacity).
 */
function resolveColour(value: string, values: Record<string, string>): Colour {
	const variable = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);
	if (variable) {
		const declared = values[variable[1]] ?? BASE[variable[1]] ?? variable[2];
		if (!declared) throw new Error(`No value for ${variable[1]}`);
		return resolveColour(declared, values);
	}
	const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*transparent\)$/);
	if (mix) {
		const base = resolveColour(mix[1], values);
		return { rgb: base.rgb, alpha: base.alpha * (Number(mix[2]) / 100) };
	}
	return colour(value);
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

/** The colour stops of a fullbleed theme's default imagery (its `--fullbleed-default-image`). */
function imageryStops(values: Record<string, string>): Rgb[] {
	return [...values['--fullbleed-default-image'].matchAll(/#[0-9a-f]{6}/gi)].map(
		(m) => colour(m[0]).rgb
	);
}

/**
 * What shows through at the darkest and lightest places of a fullbleed page: each stop of the
 * imagery under the page-wide scrim. The top and bottom bands only push further the same way
 * (dark in dark mode, light in light mode), so leaving them out is the worst case for the text.
 */
function imageryUnderScrim(values: Record<string, string>): Rgb[] {
	const scrim = colour(values['--fullbleed-scrim']);
	return imageryStops(values).map((stop) => over(scrim, stop));
}

/** Contrast of a token's colour, composited (it may be translucent), on a background. */
function textContrast(value: string, background: Rgb): number {
	return contrast(over(colour(value), background), background);
}

/** The status tints every theme shares (app.css :root). */
const BASE = tokens(app, ':root {');

/** The `color` declared by the rule for `selector` in `css` (null when it declares none). */
function declaredColour(css: string, selector: string): string | null {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const rule = css.slice(at, css.indexOf('}', at));
	// `color:` as a declaration of its own, not the end of `border-color:`.
	return rule.match(/\n\s*color:\s*([^;]+);/)?.[1].trim() ?? null;
}

/**
 * The colour an alert's `part` (text or title) of `variant` is drawn in: Alert.svelte's own, or,
 * where it inherits, the scheme's alert colour from app.css.
 */
function alertColour(variant: string, part: 'text' | 'title', dark: boolean): string {
	const own = declaredColour(alert, `.alert-${variant} .alert-${part} {`);
	if (own && own !== 'inherit') return own;
	const scheme = declaredColour(
		app,
		dark ? `\n[data-theme='dark'] .alert-${variant} {` : `\n.alert-${variant} {`
	);
	if (!scheme) throw new Error(`No ${dark ? 'dark' : 'light'} colour for .alert-${variant}`);
	return scheme;
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
	{ name: 'fullbleed glass dark', values: glassDark, behind: imageryUnderScrim(glassDark) },
	{ name: 'fullbleed glass light', values: glassLight, behind: imageryUnderScrim(glassLight) }
];

describe('theme contrast', () => {
	it.each(CASES)('$name: text on the card meets AA', ({ values, behind }) => {
		expect(behind.length).toBeGreaterThan(0);
		for (const under of behind) {
			const card = over(colour(values['--bg-card']), under);
			for (const token of ['--text-primary', '--text-secondary', '--text-muted', '--primary']) {
				const ratio = textContrast(values[token], card);
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
		expect(textContrast(values['--button-primary-text'], background)).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		{ name: 'fullbleed glass dark', values: glassDark },
		{ name: 'fullbleed glass light', values: glassLight }
	])('$name: text placed on the imagery meets AA', ({ values }) => {
		for (const under of imageryUnderScrim(values)) {
			for (const token of [
				'--fullbleed-on-image-title',
				'--fullbleed-on-image-text',
				'--fullbleed-on-image-muted'
			]) {
				expect(
					textContrast(values[token], under),
					`${token} ${values[token]} on ${under.map(Math.round)}`
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it.each(CASES)(
		'$name: alert text meets AA on its tint, on the card or the page',
		({ values, behind }) => {
			// Dark mode is where the primary text is light.
			const dark = luminance(colour(values['--text-primary']).rgb) > 0.5;
			const tints: Record<string, string> = {
				error: '--danger-light',
				warning: '--warning-light',
				success: '--success-light',
				info: '--primary-light'
			};
			for (const [variant, tint] of Object.entries(tints)) {
				for (const part of ['text', 'title'] as const) {
					const text = alertColour(variant, part, dark);
					// Full bleed alerts sit on an opaque base (so over any image); elsewhere on the
					// card or straight on the page.
					const base = values['--fullbleed-alert-base'];
					if (base) {
						expect(app).toMatch(
							new RegExp(
								`\\[data-login-theme='fullbleed-glass'\\] \\.alert\\.alert-${variant} \\{[^}]*var\\(--fullbleed-alert-base\\)`
							)
						);
					}
					const surfaces = base
						? [colour(base).rgb]
						: behind.flatMap((under) => [over(colour(values['--bg-card']), under), under]);
					for (const surface of surfaces) {
						const tinted = over(resolveColour(values[tint] ?? BASE[tint], values), surface);
						const drawn = resolveColour(text, values);
						expect(
							contrast(over(drawn, tinted), tinted),
							`${variant} ${part} ${text} on ${tinted.map(Math.round)}`
						).toBeGreaterThanOrEqual(4.5);
					}
				}
			}
		}
	);

	it.each([
		{ name: 'classic light beige', values: lightBeige },
		{ name: 'classic light blue-gray', values: lightBlueGray },
		{ name: 'classic light green', values: lightGreen },
		{ name: 'classic dark brown', values: darkBrown },
		{ name: 'classic dark navy', values: darkNavy },
		{ name: 'classic dark slate', values: darkSlate }
	])('$name: primary button text meets AA across the whole gradient', ({ values }) => {
		// Classic buttons are --gradient-primary with --text-inverse (app.css classic block); a
		// variant without its own --text-inverse inherits its scheme's (the beige or brown block).
		const dark = luminance(colour(values['--text-primary']).rgb) > 0.5;
		const text = values['--text-inverse'] ?? (dark ? darkBrown : lightBeige)['--text-inverse'];
		const stops = [...values['--gradient-primary'].matchAll(/#[0-9a-f]{6}/gi)];
		expect(stops.length).toBeGreaterThan(1);
		for (const stop of stops) {
			expect(
				textContrast(text, colour(stop[0]).rgb),
				`${text} on ${stop[0]}`
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it.each([
		{ name: 'fullbleed glass dark', values: glassDark },
		{ name: 'fullbleed glass light', values: glassLight }
	])('$name: text on a tenant image meets AA on its backdrop, over any image', ({ values }) => {
		const scrim = colour(values['--fullbleed-scrim']);
		const backdrop = colour(values['--fullbleed-on-image-backdrop-image']);
		for (const image of [[0, 0, 0] as Rgb, [255, 255, 255] as Rgb]) {
			const under = over(backdrop, over(scrim, image));
			for (const token of [
				'--fullbleed-on-image-title',
				'--fullbleed-on-image-text',
				'--fullbleed-on-image-muted'
			]) {
				expect(
					textContrast(values[token], under),
					`${token} on ${under.map(Math.round)}`
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});
