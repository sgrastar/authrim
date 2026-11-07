import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

/** Every declaration in `css` (one per `;`-ended statement) that reads `needle`. */
function declarationsReading(css: string, needle: string): string[] {
	const found: string[] = [];
	const pattern = /([a-z-]+)\s*:\s*([^;{}]*);/gi;
	for (const match of css.matchAll(pattern)) {
		if (match[2].includes(needle)) found.push(match[0]);
	}
	return found;
}

/** The rules of `css` (innermost blocks: selector and body), comments taken out. */
function rules(css: string): { selector: string; body: string }[] {
	const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
	return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
		selector: match[1].trim(),
		body: match[2]
	}));
}

/** A box with a filtered picture: its veil is painted by its .auth-image-filter layer instead. */
const FILTERED = "[data-page-image-filter='true']";

describe('page background image opacity', () => {
	it('is applied wherever the page background image is painted', () => {
		const readers = rules(app)
			.filter(({ selector }) => !selector.includes(FILTERED))
			.flatMap(({ body }) => declarationsReading(body, 'var(--login-page-background-layer'))
			.filter((d) => d.startsWith('background'));
		expect(readers.length).toBeGreaterThan(0);
		for (const declaration of readers) {
			expect(declaration, declaration).toContain('--login-page-image-veil');
		}
	});

	it('is painted over a filtered picture by its filter layer', () => {
		const filtered = rules(app).filter(
			({ selector, body }) =>
				selector.includes(FILTERED) && body.includes('var(--login-page-background-layer')
		);
		expect(filtered.length).toBeGreaterThan(0);
		for (const { body } of filtered) expect(body).not.toContain('--login-page-image-veil');
		const layers = rules(app).filter(
			({ selector, body }) => selector.includes('.auth-image-filter') && /background/.test(body)
		);
		expect(layers.length).toBeGreaterThan(0);
		for (const { selector, body } of layers) {
			expect(body, selector).toContain('var(--login-page-image-veil)');
		}
	});
});

describe('page background image grayscale', () => {
	it('puts the neutral tone layer wherever the page background image is painted', () => {
		const readers = declarationsReading(app, 'var(--login-page-background-layer').filter((d) =>
			d.startsWith('background')
		);
		for (const declaration of readers) {
			expect(declaration, declaration).toContain('var(--login-page-image-tone, none)');
		}
	});

	it('blends only the tone layer in saturation mode', () => {
		const modes = declarationsReading(app, 'saturation').filter((d) =>
			d.startsWith('background-blend-mode')
		);
		expect(modes.length).toBeGreaterThan(0);
		for (const declaration of modes) {
			const values = declaration
				.replace(/^[^:]+:\s*/, '')
				.replace(/;$/, '')
				.split(',');
			expect(
				values.filter((v) => v.trim() === 'saturation'),
				declaration
			).toHaveLength(1);
		}
	});
});
