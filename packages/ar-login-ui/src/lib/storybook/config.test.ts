import { describe, expect, it } from 'vitest';
import { PALETTE_IDS, TEMPLATE_IDS, layoutFor } from '#lib/palettes.js';
import { buildLoginUIConfig } from './config';
import { paletteFrom, templateFrom } from './globals.svelte';

describe('buildLoginUIConfig with a template and a palette', () => {
	it('saves what a tenant saves: the template, the palette and the layout that goes with it', () => {
		for (const template of TEMPLATE_IDS) {
			for (const palette of PALETTE_IDS) {
				const ui = buildLoginUIConfig({ template, palette, scheme: 'light' });
				expect(ui.pageTemplate).toMatchObject({ template, palette, layout: layoutFor(template) });
				// The pre-palette name the server sends alongside, for older Login UI builds (the
				// table of ar-management's deriveLegacyThemeTemplate).
				const meridianName = template === 'split' ? 'split-brand-panel' : 'meridian';
				const legacy: Record<(typeof PALETTE_IDS)[number], string> = {
					meridian: meridianName,
					classic: 'classic',
					'swiss-grid': 'fullbleed-glass',
					glass: meridianName,
					'clear-glass': meridianName,
					flat: meridianName
				};
				expect(ui.themeTemplate).toBe(legacy[palette]);
			}
		}
	});

	it('gives every template the server’s default top bar position', () => {
		// The server does not derive the position from the template: below the card unless set.
		for (const template of TEMPLATE_IDS) {
			expect(
				buildLoginUIConfig({ template, palette: 'meridian', scheme: 'light' }).pageTemplate
					?.topbarPosition
			).toBe('below_card');
		}
		// The pre-palette Split brand panel preset keeps its own position.
		expect(
			buildLoginUIConfig({ theme: 'split-brand-panel', scheme: 'light' }).pageTemplate
				?.topbarPosition
		).toBe('bottom_right');
	});

	it('leaves the template to the layout when a story sets only the layout', () => {
		for (const layout of ['split_panel', 'fullbleed_card', 'centered_card'] as const) {
			const ui = buildLoginUIConfig(
				{ template: 'minimal', palette: 'glass', scheme: 'light' },
				{ pageTemplate: { layout } }
			);
			expect(ui.pageTemplate?.layout).toBe(layout);
			// No template is sent, so the Login UI derives it from the layout; the palette stays.
			expect(ui.pageTemplate?.template).toBeUndefined();
			expect(ui.pageTemplate?.palette).toBe('glass');
		}
		// A story that names the template keeps it, whatever else it sets.
		const named = buildLoginUIConfig(
			{ template: 'split', palette: 'flat', scheme: 'light' },
			{ pageTemplate: { layout: 'split_panel', template: 'minimal' } }
		);
		expect(named.pageTemplate?.template).toBe('minimal');
	});

	it('lets a story override what the combination sets', () => {
		const ui = buildLoginUIConfig(
			{ template: 'split', palette: 'glass', scheme: 'light' },
			{ pageTemplate: { formFrame: 'card', topbarPosition: 'in_card' } }
		);
		expect(ui.pageTemplate).toMatchObject({
			template: 'split',
			palette: 'glass',
			formFrame: 'card',
			topbarPosition: 'in_card'
		});
	});

	it('keeps the pre-palette path for the galleries that pin a theme name', () => {
		const ui = buildLoginUIConfig({ theme: 'fullbleed-glass', scheme: 'dark' });
		expect(ui.themeTemplate).toBe('fullbleed-glass');
		expect(ui.pageTemplate).toMatchObject({ layout: 'fullbleed_card' });
		// No template or palette is sent, so the Login UI reads the old name, as it does for an
		// older server.
		expect(ui.pageTemplate?.template).toBeUndefined();
		expect(ui.pageTemplate?.palette).toBeUndefined();
	});
});

describe('toolbar values', () => {
	it('fall back to the defaults for a value the Login UI does not know', () => {
		expect(templateFrom('split')).toBe('split');
		expect(templateFrom('hero')).toBe('standard');
		expect(templateFrom(undefined)).toBe('standard');
		expect(paletteFrom('flat')).toBe('flat');
		expect(paletteFrom('split-brand-panel')).toBe('meridian');
		expect(paletteFrom(7)).toBe('meridian');
	});
});
