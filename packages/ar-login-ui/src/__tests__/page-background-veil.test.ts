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

describe('page background image opacity', () => {
	it('is applied wherever the page background image is painted', () => {
		const readers = declarationsReading(app, 'var(--login-page-background-layer').filter((d) =>
			d.startsWith('background')
		);
		expect(readers.length).toBeGreaterThan(0);
		for (const declaration of readers) {
			expect(declaration, declaration).toContain('--login-page-image-veil');
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
