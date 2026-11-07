import { describe, expect, it } from 'vitest';
import type { ScreenField } from '@authrim/ar-lib-core/types/screens';
import { translationRows } from './screen-builder';
import { fieldsToBuilder } from './screen-layout';
import {
	SCREEN_TEXT,
	localizationsToTranslations,
	translationsToLocalizations
} from './screen-texts';

const ids = () => {
	let n = 0;
	return (prefix: string) => `${prefix}-new-${++n}`;
};

const saved: ScreenField[] = [
	{
		field: 'title',
		label: 'Welcome',
		required: false,
		block_type: 'heading',
		block_id: 'title',
		text: 'Hi'
	},
	{
		field: 'or',
		label: 'Divider',
		required: false,
		block_type: 'divider',
		block_id: 'or',
		text: 'or'
	},
	// Saved without an id: its translations are under `<field>-<index>`.
	{
		field: 'plan',
		label: 'Plan',
		required: false,
		block_type: 'radio',
		store_to_profile: false,
		answer_targets: ['flow_event'],
		options: [{ value: 'pro', label: 'Pro' }]
	}
];

describe('screen translations', () => {
	it('reads a part by its id, or by its place for one saved without an id', () => {
		const screen = fieldsToBuilder(saved, ids());
		const plan = screen.rows[0].columns[0][2].id;
		const translations = localizationsToTranslations(
			{
				ja: {
					display_name: 'ようこそ',
					fields: {
						title: { label: 'ようこそ', text: 'こんにちは' },
						or: { text: 'または' },
						'plan-2': { label: 'プラン', options: { pro: 'プロ' } }
					}
				}
			},
			saved,
			screen
		);

		expect(translations).toEqual({
			[SCREEN_TEXT.name]: { ja: 'ようこそ' },
			title: { ja: 'ようこそ' },
			'title.text': { ja: 'こんにちは' },
			// A divider's shown words are its text, edited as its label.
			or: { ja: 'または' },
			[plan]: { ja: 'プラン' },
			[`${plan}.option.pro`]: { ja: 'プロ' }
		});
	});

	it('saves only the texts the screen still has, under each part id', () => {
		const screen = fieldsToBuilder(saved, ids());
		const plan = screen.rows[0].columns[0][2].id;
		const localizations = translationsToLocalizations(
			{
				[SCREEN_TEXT.name]: { ja: ' ようこそ ' },
				title: { ja: 'ようこそ', de: '' },
				or: { ja: 'または' },
				[`${plan}.option.pro`]: { ja: 'プロ' },
				[`${plan}.option.gone`]: { ja: '消えた' },
				removed: { ja: '消えた部品' }
			},
			screen
		);

		expect(localizations).toEqual({
			ja: {
				display_name: 'ようこそ',
				fields: {
					title: { label: 'ようこそ' },
					or: { text: 'または' },
					[plan]: { options: { pro: 'プロ' } }
				}
			}
		});
	});

	it("offers a divider's words to translate once, as its label", () => {
		const screen = fieldsToBuilder(saved, ids());
		const rows = translationRows(screen.rows, screen.settings).filter((row) =>
			row.id.startsWith('or')
		);

		expect(rows.map((row) => [row.id, row.source])).toEqual([['or', 'or']]);
	});
});
