<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { named, subcomponents } from '../stories/subcomponents';
	import { expect, userEvent, waitFor, within } from 'storybook/test';
	import { t } from '$lib/i18n/i18n.svelte';
	import { localized } from '../stories/sample';
	import ConditionBuilder from './ConditionBuilder.svelte';
	import ConditionGroupEditor from './ConditionGroupEditor.svelte';
	import ConditionRuleEditor from './ConditionRuleEditor.svelte';
	import type { ConditionField, ConditionGroup } from './condition-model';

	named(ConditionBuilder, 'ConditionBuilder');

	const { Story } = defineMeta({
		title: 'Patterns/Condition builder',
		component: ConditionBuilder,
		subcomponents: subcomponents({ ConditionGroupEditor, ConditionRuleEditor }),
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Conditions for service groups, role assignment rules and policies. Groups combine their members with **all / any / none of**; rules compare a field with a value, offering only the comparisons and inputs the field’s type allows (yes/no fields choose, lists offer “includes”, “is one of” takes several values as chips — Enter or a comma adds one). Up to three levels by default.\n\nAbove the builder the condition is read back as one sentence, so the admin can check what they built. Rules that cannot be evaluated say why and are reported to the SaveScope. The model is the UI’s own (`condition-model.ts`); pages convert it to each API.'
				}
			}
		}
	});

	const fields = (): ConditionField[] => [
		{
			key: 'country',
			label: localized(['国', 'Country', 'Land', 'البلد']),
			type: 'enum',
			options: [
				{ value: 'JP', label: localized(['日本', 'Japan', 'Japan', 'اليابان']) },
				{
					value: 'US',
					label: localized(['アメリカ合衆国', 'United States', 'USA', 'الولايات المتحدة'])
				},
				{ value: 'DE', label: localized(['ドイツ', 'Germany', 'Deutschland', 'ألمانيا']) }
			]
		},
		{
			key: 'department',
			label: localized(['部署', 'Department', 'Abteilung', 'القسم']),
			type: 'string'
		},
		{
			key: 'groups',
			label: localized(['IdP のグループ', 'IdP groups', 'IdP-Gruppen', 'مجموعات IdP']),
			type: 'string[]'
		},
		{
			key: 'email_verified',
			label: localized(['メール確認済み', 'Email verified', 'E-Mail bestätigt', 'البريد مؤكد']),
			type: 'boolean'
		},
		{ key: 'age', label: localized(['年齢', 'Age', 'Alter', 'العمر']), type: 'number' }
	];

	const sample = (): ConditionGroup => ({
		id: 'root',
		kind: 'group',
		match: 'all',
		children: [
			{ id: 'a', kind: 'rule', field: 'country', operator: 'in', value: ['JP', 'US'] },
			{
				id: 'g',
				kind: 'group',
				match: 'any',
				children: [
					{ id: 'b', kind: 'rule', field: 'email_verified', operator: 'eq', value: true },
					{ id: 'c', kind: 'rule', field: 'groups', operator: 'contains', value: 'admins' }
				]
			}
		]
	});
</script>

<Story
	name="Service group membership"
	play={async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// Adding a condition opens its field list; choosing a field moves on to the value.
		const adds = canvas.getAllByRole('button', { name: t('cond.addRule') });
		await userEvent.click(adds[adds.length - 1]);
		await userEvent.click(
			await body.findByRole('option', { name: /部署|Department|Abteilung|القسم/ })
		);
		const value = canvas.getAllByRole('textbox').at(-1) as HTMLElement;
		await waitFor(() => expect(value).toHaveFocus());
		await userEvent.type(value, 'sales');
		// Screen readers get the whole condition as one sentence.
		await waitFor(() =>
			expect(canvasElement.querySelector('.sr-only[id$="-summary"]')).toHaveTextContent('sales')
		);
	}}
>
	{#snippet template()}
		<div style="max-width:760px">
			<ConditionBuilder
				label={localized(['グループに入る条件', 'Who belongs', 'Wer dazugehört', 'من ينتمي'])}
				fields={fields()}
				value={sample()}
			/>
		</div>
	{/snippet}
</Story>

<Story name="A rule that cannot be evaluated">
	{#snippet template()}
		<div style="max-width:760px">
			<ConditionBuilder
				label={localized(['割り当ての条件', 'Assign when', 'Zuweisen wenn', 'التعيين عند'])}
				fields={fields()}
				value={{
					id: 'root',
					kind: 'group',
					match: 'any',
					children: [
						{ id: 'a', kind: 'rule', field: 'age', operator: 'gte', value: null },
						{ id: 'b', kind: 'rule', field: 'department', operator: 'regex', value: '(sales' }
					]
				}}
			/>
		</div>
	{/snippet}
</Story>
