<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import type { FieldType } from '$lib/api/schema-setting';
	import ListField from '$lib/ui/patterns/ListField.svelte';
	import ColumnSpan from '$lib/ui/patterns/ColumnSpan.svelte';
	import Columns from '$lib/ui/patterns/Columns.svelte';
	import TextField from '$lib/ui/primitives/TextField.svelte';
	import { RULES_PROBLEM_KEY } from './labels';
	import { ENUM_VALUES_MAX, type RulesForm, type RulesProblem } from './schema-validation';

	/**
	 * The validation rules of an attribute, as fields for its type: a text has a length and a
	 * pattern, a number a range, a choice its values, a date a range. A yes / no has none. What is
	 * wrong with them is told by the page (`problems`, from `checkRules`), field by field.
	 */
	interface Props {
		type: FieldType;
		form: RulesForm;
		problems?: Partial<Record<string, RulesProblem>>;
		disabled?: boolean;
		/** Where `form` is in a SaveScope's draft ("rules"), so the fields mark themselves once changed. */
		fieldPath?: string;
	}

	let { type, form = $bindable(), problems = {}, disabled = false, fieldPath }: Props = $props();

	const path = (name: string) => (fieldPath ? `${fieldPath}.${name}` : undefined);

	const say = (field: string) => {
		const problem = problems[field];
		return problem ? t(RULES_PROBLEM_KEY[problem]) : undefined;
	};
</script>

{#if type === 'string'}
	<Columns>
		<TextField
			label={t('ss.rules.minLength')}
			inputmode="numeric"
			bind:value={form.minLength}
			field={path('minLength')}
			error={say('minLength')}
			{disabled}
		/>
		<TextField
			label={t('ss.rules.maxLength')}
			inputmode="numeric"
			bind:value={form.maxLength}
			field={path('maxLength')}
			error={say('maxLength')}
			{disabled}
		/>
		<ColumnSpan>
			<TextField
				label={t('ss.rules.pattern')}
				hint={t('ss.rules.patternHint')}
				bind:value={form.pattern}
				field={path('pattern')}
				error={say('pattern')}
				spellcheck={false}
				{disabled}
			/>
		</ColumnSpan>
	</Columns>
{:else if type === 'number'}
	<Columns>
		<TextField
			label={t('ss.rules.min')}
			inputmode="decimal"
			bind:value={form.min}
			field={path('min')}
			error={say('min')}
			{disabled}
		/>
		<TextField
			label={t('ss.rules.max')}
			inputmode="decimal"
			bind:value={form.max}
			field={path('max')}
			error={say('max')}
			{disabled}
		/>
	</Columns>
{:else if type === 'enum'}
	<ListField
		label={t('ss.rules.enumValues')}
		hint={say('enumValues') ?? t('ss.rules.enumHint')}
		addLabel={t('ss.rules.enumAdd')}
		max={ENUM_VALUES_MAX}
		invalid={!!problems.enumValues}
		{disabled}
		bind:values={form.enumValues}
		field={path('enumValues')}
	/>
{:else if type === 'date'}
	<Columns>
		<TextField
			label={t('ss.rules.minDate')}
			type="date"
			bind:value={form.minDate}
			field={path('minDate')}
			error={say('minDate')}
			{disabled}
		/>
		<TextField
			label={t('ss.rules.maxDate')}
			type="date"
			bind:value={form.maxDate}
			field={path('maxDate')}
			error={say('maxDate')}
			{disabled}
		/>
	</Columns>
{:else}
	<p class="none">{t('ss.rules.none')}</p>
{/if}
{#if problems.rules}<p class="problem">{t(RULES_PROBLEM_KEY[problems.rules])}</p>{/if}

<style>
	.none,
	.problem {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.problem {
		color: var(--danger);
	}
</style>
