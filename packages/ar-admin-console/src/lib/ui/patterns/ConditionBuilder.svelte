<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import ConditionGroupEditor from './ConditionGroupEditor.svelte';
	import {
		MAX_DEPTH,
		describe,
		problems as findProblems,
		type ConditionField,
		type ConditionGroup,
		type Operator,
		type Wording
	} from './condition-model';

	/**
	 * Build a condition: who belongs to a service group, when a role is assigned, when a policy
	 * applies. Each rule reads as a sentence ("Country | is one of | Japan, United States"),
	 * so the builder is its own summary; groups say once how their members combine. Up to
	 * `maxDepth` levels (3 by default), beyond which conditions stop being readable.
	 *
	 * Adding a condition opens its field list at once and then moves on to the value. Rules
	 * that cannot be evaluated say why once they have been left, and are reported to the
	 * SaveScope. Screen readers also get the whole condition as one sentence.
	 */
	interface Props {
		label: string;
		value: ConditionGroup;
		fields: readonly ConditionField[];
		maxDepth?: number;
		invalid?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(),
		fields,
		maxDepth = MAX_DEPTH,
		invalid = $bindable(false),
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const changes = useChangeMark();
	const report = useInvalidReport();
	const isChanged = $derived(changed ?? changes.changed(field, value));
	const problems = $derived(findProblems(value, fields));
	$effect(() => {
		invalid = problems.size > 0;
	});
	$effect(() => report(invalid));

	/** The member just added: its field list opens by itself. */
	let fresh = $state<string | null>(null);

	const OPERATORS: readonly Operator[] = [
		'eq',
		'ne',
		'in',
		'not_in',
		'contains',
		'not_contains',
		'lt',
		'lte',
		'gt',
		'gte',
		'exists',
		'not_exists',
		'regex'
	];
	const words = $derived<Wording>({
		say: Object.fromEntries(OPERATORS.map((op) => [op, t(`cond.say.${op}`)])) as Wording['say'],
		and: t('cond.andWord'),
		or: t('cond.orWord'),
		none: t('cond.say.none'),
		yes: t('cond.yes'),
		no: t('cond.no'),
		listSeparator: t('cond.listSep'),
		empty: t('cond.emptyValue')
	});
</script>

<section
	class="builder"
	class:is-changed={isChanged}
	aria-labelledby="{uid}-label"
	aria-describedby="{uid}-summary"
>
	<p class="builder__label" id="{uid}-label">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
	</p>
	<p class="sr-only" id="{uid}-summary">{describe(value, fields, words)}</p>
	<div class="builder__body">
		<ConditionGroupEditor
			group={value}
			{fields}
			depth={1}
			{maxDepth}
			{problems}
			{fresh}
			onchange={(next, added) => {
				value = next;
				fresh = added ?? null;
			}}
		/>
	</div>
</section>

<style>
	.builder {
		display: grid;
		gap: 6px;
		min-width: 0;
	}

	.builder__label {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.builder__body {
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-card);
	}

	.is-changed .builder__body {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-card);
	}
</style>
