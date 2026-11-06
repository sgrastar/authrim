<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import {
		LOGIN_UI_LOCALES,
		getLoginUILanguageDisplayName
	} from '@authrim/ar-lib-core/types/login-ui-languages';
	import type { FieldType } from '#lib/api/schema-setting.js';
	import OptionListEditor from '#lib/ui/builder/OptionListEditor.svelte';
	import TranslationTable from '#lib/ui/builder/TranslationTable.svelte';
	import ColumnSpan from '#lib/ui/patterns/ColumnSpan.svelte';
	import Columns from '#lib/ui/patterns/Columns.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import { RULES_PROBLEM_KEY } from './labels';
	import {
		ENUM_LABEL_MAX,
		ENUM_VALUE_MAX,
		type RulesForm,
		type RulesProblem
	} from './schema-validation';

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

	// The choices' labels by Login UI language, beside the default label each choice has.
	const languages = LOGIN_UI_LOCALES.map((code) => ({
		code,
		name: getLoginUILanguageDisplayName(code, false)
	}));
	// The values a problem is about, so their fields are marked and the save can go to them.
	const invalidValue = (value: string) =>
		(problems.enumOptions === 'enum_value_empty' && value.trim() === '') ||
		(problems.enumOptions === 'enum_value_too_long' && value.trim().length > ENUM_VALUE_MAX);

	// A removed choice takes its labels with it (they would otherwise stay as an unsaved change).
	$effect(() => {
		const keys = new Set(form.enumOptions.map((option) => option.key));
		const labels = Object.entries(form.enumLabels);
		if (labels.every(([key]) => keys.has(key))) return;
		form.enumLabels = Object.fromEntries(labels.filter(([key]) => keys.has(key)));
	});

	const labelRows = $derived(
		form.enumOptions.map((option, index) => ({
			id: option.key ?? `choice-${index}`,
			label: option.value.trim() || t('options.item', { n: index + 1 }),
			source: option.label
		}))
	);
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
	<div class="choices">
		<OptionListEditor
			label={t('ss.rules.enumValues')}
			bind:options={form.enumOptions}
			field={path('enumOptions')}
			valueMaxLength={ENUM_VALUE_MAX}
			labelMaxLength={ENUM_LABEL_MAX}
			error={say('enumOptions')}
			invalid={invalidValue}
			{disabled}
		/>
		{#if !problems.enumOptions}
			<p class="choices__note">{t('ss.rules.enumHint')}</p>
		{/if}
		{#if form.enumOptions.length > 0}
			<TranslationTable
				label={t('ss.rules.enumLabels')}
				source={{ code: '', name: t('ss.rules.enumDefaultLabel') }}
				locales={languages}
				rows={labelRows}
				bind:values={form.enumLabels}
				field={path('enumLabels')}
				maxLength={ENUM_LABEL_MAX}
				{disabled}
			/>
			{#if problems.enumLabels}
				<p class="choices__note is-error">{say('enumLabels')}</p>
			{/if}
		{/if}
	</div>
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
