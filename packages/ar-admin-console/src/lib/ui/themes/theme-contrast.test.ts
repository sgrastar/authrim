import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every theme and scheme must keep text readable (WCAG AA, 4.5:1) on the surfaces it is drawn
 * on. Values are read straight from the theme CSS so a theme edit cannot silently regress.
 */

type Rgba = [number, number, number, number];
type Tokens = Record<string, string>;

const dir = import.meta.dirname;
const read = (file: string) => readFileSync(join(dir, file), 'utf8');

function blocks(css: string): Array<{ selector: string; tokens: Tokens }> {
	const result: Array<{ selector: string; tokens: Tokens }> = [];
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const tokens: Tokens = {};
		for (const decl of match[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
			tokens[decl[1]] = decl[2].trim();
		}
		result.push({ selector: match[1].trim(), tokens });
	}
	return result;
}

function tokensFor(themeFile: string | null, themeId: string, scheme: 'light' | 'dark'): Tokens {
	const standard = blocks(read('standard.css'));
	const merged: Tokens = { ...standard[0].tokens };
	if (scheme === 'dark') Object.assign(merged, standard[1].tokens);
	if (themeFile) {
		for (const block of blocks(read(themeFile))) {
			const isDark = block.selector.includes("[data-scheme='dark']");
			if (!block.selector.includes(`[data-admin-theme='${themeId}']`)) continue;
			if (!isDark || scheme === 'dark') Object.assign(merged, block.tokens);
		}
	}
	return merged;
}

function parse(value: string, tokens: Tokens, depth = 0): Rgba {
	const v = value.trim();
	const ref = v.match(/^var\(--([a-z0-9-]+)\)$/);
	if (ref && depth < 5) return parse(tokens[ref[1]], tokens, depth + 1);
	const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (hex) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
		return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1) as Rgba;
	}
	const rgb = v.match(/^rgba?\(([^)]+)\)$/);
	if (rgb) {
		const [r, g, b, a = '1'] = rgb[1].split(',').map((s) => s.trim());
		return [Number(r), Number(g), Number(b), Number(a)];
	}
	throw new Error(`Unparseable colour: ${value}`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
	const a = top[3];
	return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string, tokens: Tokens): number {
	const page = parse(tokens['bg-page'], tokens);
	const background = over(parse(tokens[bg], tokens), over(parse(tokens['bg-card'], tokens), page));
	const foreground = over(parse(tokens[fg], tokens), background);
	const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (hi + 0.05) / (lo + 0.05);
}

const TEXT_ON_SURFACE: Array<[string, string]> = [
	['text-primary', 'bg-page'],
	['text-primary', 'bg-card'],
	['text-secondary', 'bg-card'],
	['text-secondary', 'bg-subtle'],
	['text-muted', 'bg-card'],
	['text-muted', 'bg-page'],
	['text-muted', 'bg-subtle'],
	['text-inverse', 'primary'],
	['info-text', 'info-bg'],
	['warning-text', 'warning-bg'],
	['success', 'success-bg'],
	['warning', 'warning-bg'],
	['danger', 'danger-bg'],
	['info', 'info-bg'],
	...(
		[
			'comment',
			'string',
			'number',
			'keyword',
			'literal',
			'property',
			'tag',
			'attr',
			'function',
			'variable',
			'punct'
		] as const
	).map((name): [string, string] => [`code-${name}`, 'bg-input'])
];

const THEMES: Array<[string, string | null]> = [
	['standard', null],
	['swiss-grid', 'swiss-grid.css'],
	['frosted', 'frosted.css']
];

describe('theme contrast', () => {
	for (const [id, file] of THEMES) {
		for (const scheme of ['light', 'dark'] as const) {
			it(`${id} / ${scheme} keeps text at WCAG AA`, () => {
				const tokens = tokensFor(file, id, scheme);
				const failures = TEXT_ON_SURFACE.map(([fg, bg]) => ({
					pair: `${fg} on ${bg}`,
					ratio: Math.round(contrast(fg, bg, tokens) * 100) / 100
				})).filter((r) => r.ratio < 4.5);
				expect(failures).toEqual([]);
			});
		}
	}
});
