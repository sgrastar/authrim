import { describe, expect, it } from 'vitest';
import type { ScreenField } from '@authrim/ar-lib-core/types/screens';
import { builderToFields, fieldsToBuilder, kindOfField, legacyYesNoIds } from './screen-layout';

const ids = () => {
	let n = 0;
	return (prefix: string) => `${prefix}-new-${++n}`;
};

const part = (patch: Partial<ScreenField>): ScreenField => ({
	field: 'given_name',
	label: 'Given name',
	required: false,
	...patch
});

describe('fieldsToBuilder', () => {
	it('puts parts before any layout row in one row of one column', () => {
		const screen = fieldsToBuilder(
			[
				part({ block_type: 'heading', block_id: 'title', field: 'title', label: 'Hello' }),
				part({ block_id: 'given' })
			],
			ids()
		);

		expect(screen.rows).toEqual([
			{
				id: 'row-new-1',
				columns: [
					[
						{ id: 'title', kind: 'heading', label: 'Hello' },
						{ id: 'given', kind: 'identity_field', label: 'Given name' }
					]
				]
			}
		]);
		expect(screen.rowSettings['row-new-1']).toEqual({ mode: 'always', feature: 'passkey' });
	});

	it('reads a layout row up to the next one, by named column or in turn', () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_type: 'layout_row',
					block_id: 'names',
					field: 'names',
					label: 'Row',
					layout_columns: 3,
					display_condition: { mode: 'feature_enabled', feature: 'totp' }
				}),
				part({ block_id: 'a', layout_column: 3 }),
				part({ block_id: 'b' }),
				part({ block_id: 'c' }),
				part({ block_type: 'layout_row', block_id: 'rest', field: 'rest', label: 'Row' }),
				part({ block_id: 'd' })
			],
			ids()
		);

		expect(screen.rows.map((row) => row.columns.map((column) => column.map((p) => p.id)))).toEqual(
			// "In turn" counts every part of the row, as the legacy editor does.
			[[[], ['b'], ['a', 'c']], [['d']]]
		);
		expect(screen.rowSettings.names).toEqual({ mode: 'feature_enabled', feature: 'totp' });
	});

	it('reads the legacy yes/no field as a checkbox, and an answer kept off the profile', () => {
		const screen = fieldsToBuilder(
			[
				part({ block_id: 'agree', field: 'agree', value_type: 'boolean' }),
				part({
					block_type: 'select',
					block_id: 'plan',
					field: 'plan',
					store_to_profile: false,
					answer_targets: ['record'],
					show_label: false,
					options: [{ value: 'pro', label: 'Pro' }]
				})
			],
			ids()
		);

		expect(screen.rows[0].columns[0].map((p) => p.kind)).toEqual(['checkbox', 'select']);
		expect(screen.settings.plan).toMatchObject({
			linked: false,
			answerTargets: ['record'],
			showLabel: false,
			options: [{ value: 'pro', label: 'Pro' }]
		});
		expect(kindOfField(part({ value_type: 'text' }))).toBe('identity_field');
	});

	it('gives a repeated or missing id a new one', () => {
		const screen = fieldsToBuilder(
			[part({ block_id: 'x' }), part({ block_id: 'x' }), part({})],
			ids()
		);

		expect(screen.rows[0].columns[0].map((p) => p.id)).toEqual([
			'x',
			'identity_field-new-2',
			'identity_field-new-3'
		]);
	});
});

describe('builderToFields', () => {
	it('saves what it read as it was, a legacy yes/no field in its form', () => {
		const saved: ScreenField[] = [
			part({ block_type: 'heading', block_id: 'title', field: 'title', label: 'Hello', order: 10 }),
			part({ block_id: 'agree', field: 'agree', label: 'Agree', value_type: 'boolean', order: 20 }),
			part({
				block_type: 'layout_row',
				block_id: 'names',
				field: 'names',
				label: 'Row',
				layout_columns: 2,
				display_condition: { mode: 'always', feature: null },
				order: 30
			}),
			part({ block_id: 'given', layout_column: 1, order: 40, future_property: 'kept' } as never),
			part({
				block_id: 'family',
				field: 'family_name',
				label: 'Family',
				layout_column: 2,
				order: 50
			})
		];
		const fields = builderToFields(fieldsToBuilder(saved, ids()));

		expect(fields.map((field) => [field.block_type, field.block_id, field.layout_column])).toEqual([
			['heading', 'title', undefined],
			['identity_field', 'agree', undefined],
			['layout_row', 'names', undefined],
			['identity_field', 'given', 1],
			['identity_field', 'family', 2]
		]);
		expect(fields[1]).toMatchObject({ value_type: 'boolean', store_to_profile: true });
		expect(fields[3]).toMatchObject({ future_property: 'kept', field: 'given_name' });
		expect(fields.map((field) => field.order)).toEqual([10, 20, 30, 40, 50]);
		// Read back, it is the same screen.
		const again = fieldsToBuilder(fields, ids());
		expect(again.rows.map((row) => row.columns.map((c) => c.map((p) => p.id)))).toEqual([
			[['title', 'agree']],
			[['given'], ['family']]
		]);
	});

	it('writes a row across its columns, as the Login UI grid places the parts', () => {
		const screen = fieldsToBuilder([], ids());
		screen.rows = [
			{
				id: 'grid',
				columns: [
					[
						{ id: 'a', kind: 'heading', label: 'A' },
						{ id: 'c', kind: 'heading', label: 'C' }
					],
					[
						{ id: 'b', kind: 'heading', label: 'B' },
						{ id: 'd', kind: 'heading', label: 'D' },
						{ id: 'e', kind: 'heading', label: 'E' }
					]
				]
			}
		];
		screen.rowSettings = { grid: { mode: 'always', feature: 'passkey' } };

		expect(builderToFields(screen).map((field) => [field.block_id, field.layout_column])).toEqual([
			['grid', undefined],
			['a', 1],
			['b', 2],
			['c', 1],
			['d', 2],
			['e', 2]
		]);
	});

	it('writes a layout row before every row but a plain leading one, and keeps non-input keys', () => {
		const screen = fieldsToBuilder([], ids());
		screen.rows = [
			{ id: 'lead', columns: [[{ id: 'h', kind: 'heading', label: 'Hi' }]] },
			{ id: 'second', columns: [[{ id: 'f', kind: 'identity_field', label: 'Name' }]] }
		];
		screen.rowSettings = {
			lead: { mode: 'always', feature: 'passkey' },
			second: { mode: 'hidden', feature: 'passkey' }
		};
		const fields = builderToFields(screen);

		expect(fields.map((field) => field.block_type)).toEqual([
			'heading',
			'layout_row',
			'identity_field'
		]);
		expect(fields[0].field).toBe('h');
		expect(fields[1]).toMatchObject({
			block_id: 'second',
			label: 'Layout row',
			layout_columns: 1,
			display_condition: { mode: 'hidden', feature: null }
		});
		expect(fields[2].field).toBe('email');
	});

	it('sends where an answer kept off the profile goes, and its own options only then', () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_type: 'radio',
					block_id: 'plan',
					field: 'plan',
					store_to_profile: false,
					answer_targets: ['flow_event', 'record'],
					options: [{ value: 'pro', label: 'Pro' }]
				}),
				part({ block_type: 'select', block_id: 'country', field: 'country' })
			],
			ids()
		);
		const [plan, country] = builderToFields(screen);

		expect(plan).toMatchObject({
			store_to_profile: false,
			answer_targets: ['flow_event', 'record'],
			options: [{ value: 'pro', label: 'Pro' }]
		});
		expect(country.store_to_profile).toBe(true);
		expect(country).not.toHaveProperty('answer_targets');
		expect(country).not.toHaveProperty('options');
	});

	it('keeps what a part does not edit, as it was read', () => {
		const fields = builderToFields(
			fieldsToBuilder(
				[
					part({
						block_type: 'link',
						block_id: 'help',
						field: 'help',
						label: 'Help',
						href: '/help',
						display_condition: { mode: 'hidden', feature: null },
						placeholder: 'kept'
					}),
					part({
						block_type: 'auth_widget',
						block_id: 'pk',
						field: 'pk',
						label: 'Passkey',
						text: 'kept'
					})
				],
				ids()
			)
		);

		expect(fields[0]).toMatchObject({
			display_condition: { mode: 'hidden', feature: null },
			placeholder: 'kept',
			href: '/help'
		});
		expect(fields[1]).toMatchObject({ text: 'kept', required: false });
	});

	it('drops where an answer goes once it is stored to the profile', () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_type: 'radio',
					block_id: 'plan',
					field: 'plan',
					store_to_profile: false,
					answer_targets: ['record'],
					options: [{ value: 'pro', label: 'Pro' }]
				})
			],
			ids()
		);
		screen.settings.plan.linked = true;
		screen.settings.plan.field = 'gender';

		const [plan] = builderToFields(screen);
		expect(plan).toMatchObject({ store_to_profile: true, field: 'gender' });
		expect(plan).not.toHaveProperty('answer_targets');
		expect(plan).not.toHaveProperty('options');
	});

	it('keeps a legacy yes/no in its form while stored to the profile, a checkbox once it is not', () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_id: 'terms',
					field: 'terms',
					label: 'Terms of use',
					placeholder: 'I have read and agree',
					value_type: 'boolean'
				}),
				part({ block_id: 'news', field: 'news', label: 'News', value_type: 'boolean' })
			],
			ids()
		);
		// Renamed, still stored to the profile: the lite Login UI reads only this form for now.
		screen.rows[0].columns[0][0].label = 'Terms';
		// Kept off the profile: a checkbox to the API.
		screen.settings.news.linked = false;
		screen.settings.news.field = 'news_answer';

		const [terms, news] = builderToFields(screen);
		expect(terms).toMatchObject({
			block_type: 'identity_field',
			value_type: 'boolean',
			label: 'Terms',
			placeholder: 'I have read and agree'
		});
		expect(news.block_type).toBe('checkbox');
		expect(news).not.toHaveProperty('value_type');
	});

	it('knows the parts read in the legacy yes/no form, and no longer once saved as a checkbox', () => {
		const read = fieldsToBuilder(
			[
				part({ block_id: 'terms', field: 'terms', value_type: 'boolean', placeholder: 'I agree' }),
				part({ block_type: 'checkbox', block_id: 'news', field: 'news', placeholder: 'left over' })
			],
			ids()
		);
		expect([...legacyYesNoIds(read.origins)]).toEqual(['terms']);

		// Moved off the profile and saved: a checkbox from then on, whatever its placeholder.
		read.settings.terms.linked = false;
		read.settings.terms.field = 'terms_answer';
		const again = fieldsToBuilder(builderToFields(read), ids());
		expect([...legacyYesNoIds(again.origins)]).toEqual([]);
	});

	it("writes a legacy yes/no question's edited box text", () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_id: 'terms',
					field: 'terms',
					label: 'Terms of use',
					placeholder: 'I have read and agree',
					value_type: 'boolean'
				})
			],
			ids()
		);
		screen.settings.terms.placeholder = 'I agree to the new terms';

		expect(builderToFields(screen)[0]).toMatchObject({
			block_type: 'identity_field',
			placeholder: 'I agree to the new terms'
		});
	});

	it('reads an older code input that named its code by auth_method', () => {
		const screen = fieldsToBuilder(
			[
				part({
					block_type: 'code_input_widget',
					block_id: 'code',
					field: 'code',
					label: 'Code',
					auth_method: 'totp'
				})
			],
			ids()
		);

		expect(screen.settings.code.codeMode).toBe('totp');
		expect(builderToFields(screen)[0].code_input_mode).toBe('totp');
	});
});
