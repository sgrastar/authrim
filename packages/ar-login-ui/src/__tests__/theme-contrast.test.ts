import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveLoginUIThemeBackground } from '../lib/theme-bootstrap';

/**
 * Text contrast of every built-in theme and scheme, read from the stylesheets.
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

/**
 * What shows through a Glass pane, in the places that are hardest on the text: the page colour,
 * and the page colour under each layer of the backdrop's light and shade (`rgba(r, g, b, a)`).
 * A pane is translucent, so its text must read over every one of them.
 */
function glassBehind(values: Record<string, string>): Rgb[] {
	const page = colour(values['--bg-page']).rgb;
	const layers = [...values['--glass-backdrop'].matchAll(/rgba\([^)]+\)/g)].map((m) =>
		over(colour(m[0]), page)
	);
	return [page, ...layers];
}

/**
 * The most opaque `rgba()` stop of a gradient (a variable of the theme is followed first): the
 * point where a white reflection or gloss is strongest.
 */
function brightestStop(value: string, values: Record<string, string>): Colour {
	const variable = value.match(/^var\((--[\w-]+)\)$/);
	if (variable) return brightestStop(values[variable[1]], values);
	const stops = [...value.matchAll(/rgba\([^)]+\)/g)].map((m) => colour(m[0]));
	if (stops.length === 0) return { rgb: [0, 0, 0], alpha: 0 };
	return stops.reduce((a, b) => (b.alpha > a.alpha ? b : a));
}

/** A colour stop of a gradient (or a plain colour): `rgba()` or six-digit hex. */
const STOP = /rgba\([^)]+\)|#[0-9a-f]{6}\b/gi;

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
	/** Over a picture the parts sit on the protected pane only, never on the bare photo. */
	paneOnly?: boolean;
}

/** Where a part of the form can sit: on the card (over what shows through it) or on the page. */
function surfacesOf({ values, behind, paneOnly }: Case): Rgb[] {
	// Clear glass draws its reflection on the card's face (.card::before): where it is brightest
	// too.
	const reflection = values['--glass-sheen']
		? brightestStop(values['--glass-sheen'], values)
		: null;
	return behind.flatMap((under) => {
		const pane = over(colour(values['--bg-card']), under);
		const panes = reflection ? [pane, over(reflection, pane)] : [pane];
		return paneOnly ? panes : [...panes, under];
	});
}

const BOUNDARY = ':is(:root, .login-ui-theme-boundary)';
const classic = (selector: string) => tokens(themes, selector);
const page = (values: Record<string, string>) => [colour(values['--bg-page']).rgb];

const meridianLight = tokens(app, `${BOUNDARY}[data-login-theme='meridian'],`);
const meridianDark = tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='meridian'],`);
// Swiss Grid and Glass: light is the base, dark overrides it (as flat does).
const swissLight = tokens(app, `${BOUNDARY}[data-login-theme='swiss-grid'] {`);
const swissDark = {
	...swissLight,
	...tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='swiss-grid'] {`)
};
const glassLight = tokens(app, `${BOUNDARY}[data-login-theme='glass'] {`);
const glassDark = {
	...glassLight,
	...tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='glass'] {`)
};
const clearLight = tokens(app, `${BOUNDARY}[data-login-theme='clear-glass'] {`);
const clearDark = {
	...clearLight,
	...tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='clear-glass'] {`)
};

/** Over a tenant's picture (and in the split card) the glasses' panes are protected. */
const PHOTOS: Rgb[] = [
	[0, 0, 0],
	[255, 255, 255],
	[16, 26, 56]
];
const pictureLight = tokens(
	app,
	"[data-login-theme='glass'][data-has-page-background-image='true'],"
);
const pictureDark = tokens(
	app,
	"[data-theme='dark'][data-login-theme='glass'][data-has-page-background-image='true'],"
);
/** Clear glass over a white, a black or a dark-blue photo, with the protection applied. */
const CLEAR_ON_PICTURE: Case[] = [
	{
		name: 'clear glass light over a picture',
		values: { ...clearLight, ...pictureLight },
		behind: PHOTOS,
		paneOnly: true
	},
	{
		name: 'clear glass dark over a picture',
		values: { ...clearDark, ...pictureLight, ...pictureDark },
		behind: PHOTOS,
		paneOnly: true
	}
];

/**
 * The opaque fallbacks (reduced transparency, no backdrop-filter): each block's light and dark
 * token rules, laid over Clear glass's own.
 */
function fallbackTokens(opening: string): [Record<string, string>, Record<string, string>] {
	const block = app.slice(app.lastIndexOf(opening));
	const bodies = [...block.matchAll(/\{([^{}]*--bg-card[^{}]*)\}/g)].slice(0, 2);
	const read = (body: string) =>
		Object.fromEntries(
			[...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
		);
	return [read(bodies[0][1]), read(bodies[1][1])];
}
const CLEAR_FALLBACKS: Case[] = [
	'@media (prefers-reduced-transparency: reduce) {',
	'@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {'
].flatMap((opening) => {
	const [light, dark] = fallbackTokens(opening);
	const kind = opening.startsWith('@media') ? 'reduced transparency' : 'no backdrop-filter';
	const lightValues = { ...clearLight, ...light };
	const darkValues = { ...clearDark, ...light, ...dark };
	return [
		{ name: `clear glass light, ${kind}`, values: lightValues, behind: page(lightValues) },
		{ name: `clear glass dark, ${kind}`, values: darkValues, behind: page(darkValues) }
	];
});

const flatLight = tokens(app, `${BOUNDARY}[data-login-theme='flat'] {`);
const flatDark = {
	...flatLight,
	...tokens(app, `${BOUNDARY}[data-theme='dark'][data-login-theme='flat'] {`)
};

const classicLight = classic(":root,\n[data-theme='light'] {");
const classicDark = classic("/* === Dark Theme === */\n[data-theme='dark'] {");

const CASES: Case[] = [
	{ name: 'classic light', values: classicLight, behind: page(classicLight) },
	{ name: 'classic dark', values: classicDark, behind: page(classicDark) },
	{ name: 'meridian / split light', values: meridianLight, behind: page(meridianLight) },
	{ name: 'meridian / split dark', values: meridianDark, behind: page(meridianDark) },
	{ name: 'flat light', values: flatLight, behind: page(flatLight) },
	{ name: 'flat dark', values: flatDark, behind: page(flatDark) },
	{ name: 'swiss grid light', values: swissLight, behind: page(swissLight) },
	{ name: 'swiss grid dark', values: swissDark, behind: page(swissDark) },
	{ name: 'glass light', values: glassLight, behind: glassBehind(glassLight) },
	{ name: 'glass dark', values: glassDark, behind: glassBehind(glassDark) },
	{ name: 'clear glass light', values: clearLight, behind: glassBehind(clearLight) },
	{ name: 'clear glass dark', values: clearDark, behind: glassBehind(clearDark) }
];

/** The destructive / warning colours: the base ones, with the scheme's own. */
const status = (dark: boolean) => ({
	...BASE,
	...tokens(app, dark ? "[data-theme='dark'] {" : "[data-theme='light'] {")
});

describe('theme contrast', () => {
	it('each scheme sets every status colour the other changes', () => {
		// A boundary of one scheme inside a document of the other inherits whatever it leaves unset.
		const light = Object.keys(tokens(app, "[data-theme='light'] {")).sort();
		const dark = Object.keys(tokens(app, "[data-theme='dark'] {")).sort();
		expect(light).toEqual(dark);
	});

	it.each(CASES)(
		'$name: destructive buttons and error / warning text meet AA',
		({ name, values, behind }) => {
			const tones = status(name.includes(' dark'));
			expect(
				textContrast(tones['--danger-text'], colour(tones['--danger-bg']).rgb)
			).toBeGreaterThanOrEqual(4.5);
			for (const under of behind) {
				const card = over(colour(values['--bg-card']), under);
				expect(textContrast(tones['--danger-fg'], card)).toBeGreaterThanOrEqual(4.5);
				// Warning text sits on the warning tint (a tag, a notice) as well as on the card.
				const tinted = over(colour(tones['--warning-light']), card);
				expect(textContrast(tones['--warning-fg'], tinted)).toBeGreaterThanOrEqual(4.5);
				const errorTinted = over(colour(tones['--danger-light']), card);
				expect(textContrast(tones['--danger-fg'], errorTinted)).toBeGreaterThanOrEqual(4.5);
			}
		}
	);

	it.each(CASES)(
		'$name: text on subtle fills (counts, tags, hovered controls) meets AA',
		({ name, values, behind }) => {
			const tones = status(name.includes(' dark'));
			for (const under of behind) {
				const subtle = over(
					colour(values['--bg-subtle']),
					over(colour(values['--bg-card']), under)
				);
				for (const token of ['--text-primary', '--text-secondary']) {
					expect(
						textContrast(values[token], subtle),
						`${token} ${values[token]} on ${subtle.map(Math.round)}`
					).toBeGreaterThanOrEqual(4.5);
				}
				// An active favourite star (an icon: 3:1) while hovered.
				expect(textContrast(tones['--warning-fg'], subtle)).toBeGreaterThanOrEqual(3);
			}
		}
	);

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
		{ name: 'swiss grid light', values: swissLight },
		{ name: 'swiss grid dark', values: swissDark }
	])('$name: primary button text meets AA', ({ values }) => {
		const background = colour(
			values['--button-primary-bg'] === 'var(--primary)'
				? values['--primary']
				: values['--button-primary-bg']
		).rgb;
		expect(textContrast(values['--button-primary-text'], background)).toBeGreaterThanOrEqual(4.5);
	});

	it.each([
		{ name: 'glass light', values: glassLight },
		{ name: 'glass dark', values: glassDark },
		{ name: 'clear glass light', values: clearLight },
		{ name: 'clear glass dark', values: clearDark }
	])(
		"$name: the blue-glass primary button's label meets AA over the pane and the backdrop",
		({ values }) => {
			// The preset button is translucent blue (one colour, or a gradient), over the pane, over what
			// shows through the pane. A tenant's accent replaces it with a solid fill (and its own label
			// colour). Clear glass lays its reflection over the tint: its brightest stop counts too.
			const stops = [...values['--glass-primary-bg'].matchAll(/rgba\([^)]+\)/g)].map((m) =>
				colour(m[0])
			);
			expect(stops.length).toBeGreaterThan(0);
			const sheen = values['--glass-sheen']?.match(/rgba\([^)]+\)/)?.[0];
			const label = colour(values['--button-primary-text']);
			for (const under of glassBehind(values)) {
				const pane = over(colour(values['--bg-card']), under);
				for (const stop of stops) {
					const tinted = over(stop, pane);
					for (const button of sheen ? [tinted, over(colour(sheen), tinted)] : [tinted]) {
						expect(
							contrast(over(label, button), button),
							`label ${values['--button-primary-text']} on ${button.map(Math.round)}`
						).toBeGreaterThanOrEqual(4.5);
					}
				}
			}
		}
	);

	it.each([
		{ name: 'glass light', scheme: 'light', base: glassLight },
		{ name: 'glass dark', scheme: 'dark', base: glassDark },
		{ name: 'clear glass light', scheme: 'light', base: clearLight },
		{ name: 'clear glass dark', scheme: 'dark', base: clearDark }
	])(
		'$name: text on a pane over a tenant picture meets AA over a white or a black photo',
		({ scheme, base }) => {
			// One rule makes both glasses' panes opaque enough over a picture.
			const pictureLight = tokens(
				app,
				"[data-login-theme='glass'][data-has-page-background-image='true'],"
			);
			const pictureDark = tokens(
				app,
				"[data-theme='dark'][data-login-theme='glass'][data-has-page-background-image='true'],"
			);
			const values = {
				...base,
				...pictureLight,
				...(scheme === 'dark' ? pictureDark : {})
			};
			// A white or a black photo, and the split template's dark brand panel under a floating card.
			for (const photo of [[0, 0, 0] as Rgb, [255, 255, 255] as Rgb, [16, 26, 56] as Rgb]) {
				const card = over(colour(values['--bg-card']), photo);
				// The links (the one under the card among them) are in the accent.
				for (const token of ['--text-primary', '--text-secondary', '--text-muted', '--primary']) {
					expect(
						textContrast(values[token], card),
						`${token} ${values[token]} on ${card.map(Math.round)} over ${photo}`
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	);

	it.each([
		{ name: 'clear glass light', values: clearLight, behind: glassBehind(clearLight) },
		{ name: 'clear glass dark', values: clearDark, behind: glassBehind(clearDark) },
		...CLEAR_ON_PICTURE
	])('$name: a status badge’s label meets AA under its gloss', (testCase) => {
		const { values } = testCase;
		const gloss = brightestStop(values['--glass-gloss'], values);
		const badges: [string, string][] = [
			['--glass-text-success', '--success-light'],
			['--glass-text-warning', '--warning-light'],
			['--glass-text-danger', '--danger-light'],
			['--text-primary', '--primary-light'],
			['--text-secondary', 'rgba(100, 116, 139, 0.1)']
		];
		const surfaces = surfacesOf(testCase);
		for (const [text, tint] of badges) {
			const tintColour = tint.startsWith('--')
				? resolveColour(values[tint] ?? BASE[tint], values)
				: colour(tint);
			for (const surface of surfaces) {
				for (const face of [over(tintColour, surface), over(gloss, over(tintColour, surface))]) {
					expect(
						textContrast(values[text], face),
						`${text} on ${tint} at ${face.map(Math.round)}`
					).toBeGreaterThanOrEqual(4.5);
				}
			}
		}
	});

	it.each([
		{ name: 'clear glass light', values: clearLight, behind: glassBehind(clearLight) },
		{ name: 'clear glass dark', values: clearDark, behind: glassBehind(clearDark) },
		...CLEAR_ON_PICTURE,
		...CLEAR_FALLBACKS
	])(
		'$name: a field’s, a switch’s and its thumb’s hairline shows the control at 3:1',
		(testCase) => {
			const { values } = testCase;
			const line = colour(values['--glass-line']);
			const surfaces = surfacesOf(testCase);
			// The page or the card; a switch's off track, its on track (each stop of the palette's
			// tint, which a tenant's accent does not change), and a field's face.
			const track = colour(values['--glass-toggle-track']);
			const tint = [...values['--glass-primary-bg'].matchAll(STOP)].map((m) => colour(m[0]));
			const field = colour(values['--bg-input']);
			// The thumb, where it is faintest (its least opaque stop: there it stands out least from
			// the track). Its outline lies outside it, on the off or the on track.
			const thumb = [...values['--glass-thumb'].matchAll(STOP)]
				.map((m) => colour(m[0]))
				.reduce((a, b) => (b.alpha < a.alpha ? b : a));
			for (const surface of surfaces) {
				// Each face the line bounds: a field, the off track, the on track (each stop of the
				// palette's tint).
				const tracks = [over(track, surface), ...tint.map((stop) => over(stop, surface))];
				for (const under of [surface, over(field, surface), ...tracks]) {
					expect(
						contrast(over(line, under), under),
						`${values['--glass-line']} on ${under.map(Math.round)}`
					).toBeGreaterThanOrEqual(3);
				}
				// The thumb shows where it is (on or off) if it stands out from the track by itself,
				// or else if its outline stands out from both the track and the thumb.
				for (const face of tracks) {
					const disc = over(thumb, face);
					const outline = over(line, face);
					const shown =
						contrast(disc, face) >= 3 ||
						(contrast(outline, face) >= 3 && contrast(outline, disc) >= 3);
					expect(
						shown,
						`thumb ${disc.map(Math.round)} on ${face.map(Math.round)}: ` +
							`${contrast(disc, face).toFixed(2)} by itself, outline ` +
							`${contrast(outline, face).toFixed(2)} / ${contrast(outline, disc).toFixed(2)}`
					).toBe(true);
				}
			}
		}
	);

	it.each([...CASES, ...CLEAR_ON_PICTURE])(
		'$name: alert text meets AA on its tint, on the card or the page',
		(testCase) => {
			const { values } = testCase;
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
					// An alert sits on the card or straight on the page.
					const surfaces = surfacesOf(testCase);
					// Clear glass lays its reflection over the tint: its brightest stop as well.
					const reflection = values['--glass-alert-sheen']
						? brightestStop(values['--glass-alert-sheen'], values)
						: null;
					for (const surface of surfaces) {
						const tint0 = over(resolveColour(values[tint] ?? BASE[tint], values), surface);
						for (const tinted of reflection ? [tint0, over(reflection, tint0)] : [tint0]) {
							const drawn = resolveColour(text, values);
							expect(
								contrast(over(drawn, tinted), tinted),
								`${variant} ${part} ${text} on ${tinted.map(Math.round)}`
							).toBeGreaterThanOrEqual(4.5);
						}
					}
				}
			}
		}
	);

	it.each([
		{ name: 'classic light', values: classicLight },
		{ name: 'classic dark', values: classicDark }
	])('$name: primary button text meets AA across the whole gradient', ({ values }) => {
		// Classic buttons are --gradient-primary with --text-inverse (app.css classic block).
		const text = values['--text-inverse'];
		const stops = [...values['--gradient-primary'].matchAll(/#[0-9a-f]{6}/gi)];
		expect(stops.length).toBeGreaterThan(1);
		for (const stop of stops) {
			expect(
				textContrast(text, colour(stop[0]).rgb),
				`${text} on ${stop[0]}`
			).toBeGreaterThanOrEqual(4.5);
		}
	});
});

describe('first paint', () => {
	it('paints the page background each theme template has in each mode', () => {
		const pageColour = (values: Record<string, string>) =>
			values['--login-page-background-color'] ?? values['--bg-page'];
		const expected: Array<[string, 'light' | 'dark', Record<string, string>]> = [
			['classic', 'light', classicLight],
			['classic', 'dark', classicDark],
			['meridian', 'light', meridianLight],
			['meridian', 'dark', meridianDark],
			['split-brand-panel', 'light', meridianLight],
			['split-brand-panel', 'dark', meridianDark],
			['swiss-grid', 'light', swissLight],
			['swiss-grid', 'dark', swissDark],
			['glass', 'light', glassLight],
			['glass', 'dark', glassDark],
			['clear-glass', 'light', clearLight],
			['clear-glass', 'dark', clearDark],
			// An older server's name for what is now Swiss Grid.
			['fullbleed-glass', 'light', swissLight],
			['fullbleed-glass', 'dark', swissDark]
		];
		for (const [template, mode, values] of expected) {
			expect(resolveLoginUIThemeBackground(mode, template), `${template} ${mode}`).toBe(
				pageColour(values).toLowerCase()
			);
		}
	});
});
