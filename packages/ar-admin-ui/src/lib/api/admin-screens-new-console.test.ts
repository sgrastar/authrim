import { describe, expect, it } from 'vitest';
import { screenNeedsNewConsole, type ScreenField } from './admin-screens';

const field = (patch: Partial<ScreenField>): ScreenField => ({
	field: 'given_name',
	label: 'Given name',
	required: false,
	...patch
});

describe('screenNeedsNewConsole', () => {
	it('lets this editor keep a screen of the parts it knows', () => {
		expect(
			screenNeedsNewConsole([
				field({}),
				field({ field: 'agree', value_type: 'boolean' }),
				field({ field: 'row', block_type: 'layout_row', layout_columns: 2 }),
				field({ field: 'help', block_type: 'link', href: '/help', link_style: 'text' })
			])
		).toBe(false);
	});

	it.each([
		['a choice part', field({ block_type: 'select' })],
		['radio buttons', field({ block_type: 'radio' })],
		['a checkbox', field({ block_type: 'checkbox' })],
		['a hidden label', field({ show_label: false })],
		['an answer kept off the profile', field({ store_to_profile: false })],
		['where such an answer goes', field({ answer_targets: ['record'] })],
		['its own options', field({ options: [{ value: 'a', label: 'A' }] })],
		['a three-column row', field({ block_type: 'layout_row', layout_columns: 3 })],
		[
			'a link leaving by an exit',
			field({ block_type: 'link', link_action: 'exit', link_exit: 'social' })
		],
		['a link going back', field({ block_type: 'link', link_action: 'back' })],
		['a link drawn as a button', field({ block_type: 'link', href: '/help', link_style: 'button' })]
	])('leaves a screen with %s to the new admin console', (_name, part) => {
		expect(screenNeedsNewConsole([field({}), part])).toBe(true);
	});
});
