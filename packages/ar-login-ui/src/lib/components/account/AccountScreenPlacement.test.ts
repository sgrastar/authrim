import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { AccountPageScreenField } from '$lib/api/account';
import AccountScreenPlacement from './AccountScreenPlacement.svelte';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

const placementSource = readFileSync(
	new URL('./AccountScreenPlacement.svelte', import.meta.url),
	'utf8'
);

const field = (overrides: Partial<AccountPageScreenField> = {}): AccountPageScreenField => ({
	field: 'block',
	label: 'Label',
	required: false,
	...overrides
});

describe('AccountScreenPlacement', () => {
	function renderPlacement(props: Partial<Parameters<typeof AccountScreenPlacement>[1]> = {}) {
		return render(AccountScreenPlacement, {
			props: {
				id: 'overview',
				fields: [
					field({ field: 'heading', block_type: 'heading', layout_column: 1 }),
					field({ field: 'row', block_type: 'layout_row' }),
					field({ field: 'text', block_type: 'text', layout_column: 2 })
				],
				block: createRawSnippet((current: () => AccountPageScreenField) => ({
					render: () => `<span>${current().field}</span>`
				})),
				...props
			}
		}).body.replace(HYDRATION_MARKERS, '');
	}

	it('renders full-width overview placements as a visible card spanning the account grid', () => {
		expect(renderPlacement({ full: true, overview: true })).toMatch(
			/<section id="overview" class="account-screen[^"]*\bfull\b[^"]*\boverview\b/
		);
		expect(renderPlacement()).not.toMatch(/class="account-screen[^"]*\b(full|overview)\b/);
		expect(placementSource).toMatch(/\.account-screen\.full\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/s);
		expect(placementSource).toMatch(/\.account-screen\.overview\s*\{[^}]*background:/s);
	});

	it('draws each block in order and skips layout rows', () => {
		const body = renderPlacement();
		expect(body).toMatch(/<span>heading<\/span>[\s\S]*<span>text<\/span>/);
		expect(body).not.toContain('<span>row</span>');
		expect(body.match(/account-screen__block/g)).toHaveLength(2);
	});

	it('places blocks in column 1 or 2 only inside a full-width placement', () => {
		const full = renderPlacement({ full: true });
		expect(full).toContain('--account-block-column: 1');
		expect(full).toContain('--account-block-column: 2');
		expect(renderPlacement()).not.toContain('--account-block-column');
		// Narrow screens stack every block, without an inline style to override.
		expect(placementSource).toMatch(
			/@media \(max-width: 760px\)[\s\S]*\.account-screen__block\s*\{\s*grid-column:\s*1;/
		);
		expect(placementSource).not.toContain('!important');
	});
});
