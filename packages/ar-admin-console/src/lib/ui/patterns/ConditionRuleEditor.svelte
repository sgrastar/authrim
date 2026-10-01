<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { MessageKey } from '$lib/i18n/messages/ja';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import SelectMenu from '../primitives/SelectMenu.svelte';
	import { parseNumberInput } from '../primitives/number-input';
	import {
		OPERATORS_BY_TYPE,
		changeField,
		changeOperator,
		takesList,
		takesNoValue,
		type ConditionField,
		type ConditionRule,
		type Operator,
		type RuleProblem
	} from './condition-model';

	/**
	 * One rule, written as a sentence: field · comparison · value ("Country | is one of |
	 * Japan, United States"). Each part is a word that opens its choices; nothing is boxed
	 * until it is used. The comparisons and the value input follow the field's type.
	 *
	 * A rule just added opens its field list at once; choosing a field moves on to the value.
	 * A problem shows once the rule has been left, not while it is being written.
	 */
	interface Props {
		rule: ConditionRule;
		fields: readonly ConditionField[];
		/** Position in its group, for names read out ("Condition 2"). */
		n: number;
		problem?: RuleProblem;
		/** Just added: open the field list. */
		fresh?: boolean;
		onchange: (rule: ConditionRule) => void;
		onremove: () => void;
	}

	let { rule, fields, n, problem, fresh = false, onchange, onremove }: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	let row = $state<HTMLDivElement>();
	// A rule being written shows problems once left; one that was already there, at once.
	let touched = $state(untrack(() => !fresh));
	let draft = $state('');

	const field = $derived(fields.find((f) => f.key === rule.field));
	const name = $derived(t('cond.rule', { n }));
	const operators = $derived(field ? OPERATORS_BY_TYPE[field.type] : []);
	const list = $derived(Array.isArray(rule.value) ? rule.value : []);
	const labelOf = (value: string) => field?.options?.find((o) => o.value === value)?.label ?? value;
	const showProblem = $derived(touched && !!problem);

	async function focusValue() {
		await tick();
		row?.querySelector<HTMLElement>('[data-value] input, [data-value] button')?.focus();
	}

	function addValues(text: string) {
		const values = text
			.split(/[,、\n]/)
			.map((v) => v.trim())
			.filter((v) => v && !list.includes(v));
		if (values.length) onchange({ ...rule, value: [...list, ...values] });
		draft = '';
	}

	function setText(text: string) {
		if (field?.type !== 'number') return onchange({ ...rule, value: text });
		const parsed = parseNumberInput(text, { whole: false });
		onchange({ ...rule, value: parsed.problem ? text : parsed.value });
	}

	const problemKey: Record<RuleProblem, MessageKey> = {
		noField: 'cond.problem.noField',
		noValue: 'cond.problem.noValue',
		notNumber: 'cond.problem.notNumber',
		badPattern: 'cond.problem.badPattern'
	};
	const text = $derived(rule.value === null || Array.isArray(rule.value) ? '' : String(rule.value));
</script>

<!-- Leaving the whole rule (not moving between its parts) counts as done with it. -->
<div
	class="rule"
	class:has-problem={showProblem}
	role="group"
	aria-label={name}
	bind:this={row}
	onfocusout={(event) => {
		if (!row?.contains(event.relatedTarget as Node | null)) touched = true;
	}}
>
	<div class="rule__line">
		<span class="rule__field">
			<SelectMenu
				label="{t('cond.field')} — {name}"
				hideLabel
				variant="inline"
				autoOpen={fresh}
				value={rule.field}
				options={fields.map((f) => ({ value: f.key, label: f.label }))}
				onchange={(key) => {
					const next = fields.find((f) => f.key === key);
					if (next) {
						onchange(changeField(rule, next));
						focusValue();
					}
				}}
			/>
		</span>
		<span class="rule__operator">
			<SelectMenu
				label="{t('cond.operator')} — {name}"
				hideLabel
				variant="inline"
				value={rule.operator}
				options={operators.map((op) => ({ value: op, label: t(`cond.op.${op}`) }))}
				onchange={(op) => {
					onchange(changeOperator(rule, op as Operator, field));
					focusValue();
				}}
			/>
		</span>

		{#if !takesNoValue(rule.operator)}
			<span class="rule__value" data-value>
				{#if field?.type === 'boolean'}
					<SelectMenu
						label="{t('cond.value')} — {name}"
						hideLabel
						variant="inline"
						value={rule.value === false ? 'false' : 'true'}
						options={[
							{ value: 'true', label: t('cond.yes') },
							{ value: 'false', label: t('cond.no') }
						]}
						onchange={(v) => onchange({ ...rule, value: v === 'true' })}
					/>
				{:else if field?.type === 'enum' && !takesList(rule.operator)}
					<SelectMenu
						label="{t('cond.value')} — {name}"
						hideLabel
						variant="inline"
						value={String(rule.value ?? '')}
						options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
						onchange={(v) => onchange({ ...rule, value: v })}
					/>
				{:else if takesList(rule.operator)}
					<span class="rule__chips" role="group" aria-label="{t('cond.value')} — {name}">
						{#each list as value (value)}
							<span class="chip">
								<span>{labelOf(value)}</span>
								<button
									type="button"
									class="chip__remove"
									aria-label={t('cond.removeValue', { value: labelOf(value) })}
									disabled={busy()}
									onclick={() => onchange({ ...rule, value: list.filter((v) => v !== value) })}
									><Icon name="close" /></button
								>
							</span>
						{/each}
						{#if field?.type === 'enum'}
							{@const rest = (field.options ?? []).filter((o) => !list.includes(o.value))}
							{#if rest.length}
								<SelectMenu
									label="{t('list.add')} — {name}"
									hideLabel
									variant="inline"
									placeholder={t('list.add')}
									value=""
									options={rest.map((o) => ({ value: o.value, label: o.label }))}
									onchange={(v) => onchange({ ...rule, value: [...list, v] })}
								/>
							{/if}
						{:else}
							<input
								class="token"
								class:is-empty={!draft && list.length === 0}
								bind:value={draft}
								size={Math.max(6, draft.length + 1)}
								aria-label="{t('cond.value')} — {name}"
								aria-describedby="{uid}-hint"
								aria-invalid={problem ? 'true' : undefined}
								readonly={busy()}
								onkeydown={(event) => {
									if (event.key === 'Enter' || event.key === ',') {
										event.preventDefault();
										addValues(draft);
									} else if (event.key === 'Backspace' && !draft && list.length) {
										onchange({ ...rule, value: list.slice(0, -1) });
									}
								}}
								onblur={() => draft && addValues(draft)}
								onpaste={(event) => {
									const pasted = event.clipboardData?.getData('text') ?? '';
									if (/[,、\n]/.test(pasted)) {
										event.preventDefault();
										addValues(pasted);
									}
								}}
							/>
							<span class="sr-only" id="{uid}-hint">{t('cond.valueHint')}</span>
						{/if}
					</span>
				{:else}
					<input
						class="token"
						class:is-empty={text === ''}
						class:is-mono={rule.operator === 'regex'}
						dir={rule.operator === 'regex' ? 'ltr' : undefined}
						value={text}
						size={Math.max(6, text.length + 1)}
						inputmode={field?.type === 'number' ? 'decimal' : undefined}
						aria-label="{t('cond.value')} — {name}"
						aria-invalid={problem ? 'true' : undefined}
						aria-describedby={showProblem ? `${uid}-problem` : undefined}
						spellcheck="false"
						readonly={busy()}
						oninput={(event) => setText(event.currentTarget.value)}
					/>
				{/if}
			</span>
		{/if}

		<span class="rule__remove">
			<IconButton
				icon="close"
				label={t('cond.removeRule', { n })}
				disabled={busy()}
				onclick={onremove}
			/>
		</span>
	</div>
	{#if showProblem && problem}
		<p class="rule__problem" id="{uid}-problem">{t(problemKey[problem])}</p>
	{/if}
</div>

<style>
	.rule {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	/* The parts of a rule read like one sentence and wrap like one. */
	.rule__line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 4px;
		min-height: var(--control-h-sm);
	}

	.rule__field :global(.select-menu__button) {
		font-weight: var(--fw-semibold);
	}

	.rule__operator :global(.select-menu__button) {
		color: var(--text-secondary);
	}

	.rule__value {
		display: inline-flex;
		min-width: 0;
	}

	/* A value typed in place: a line under it, a box when used. */
	.token {
		height: var(--control-h-sm);
		padding: 0 6px;
		border: 1px solid transparent;
		border-bottom-color: var(--border-strong);
		border-radius: var(--radius-xs);
		background: transparent;
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-body);
	}

	.token.is-empty {
		border: 1px dashed var(--border-strong);
		background: var(--bg-input);
	}

	.token:hover,
	.token:focus-visible {
		border: 1px solid var(--border-strong);
		background: var(--bg-input);
	}

	.token:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	.token.is-mono {
		font-family: var(--font-mono);
	}

	.has-problem .token {
		border: 1px solid var(--danger);
	}

	.rule__chips {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 22px;
		padding-inline: 8px 2px;
		border: 1px solid var(--border);
		border-radius: var(--radius-badge);
		background: var(--bg-subtle);
		font-size: var(--fs-body);
	}

	.chip__remove {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-round);
		background: transparent;
		color: var(--text-muted);
		--icon-size: var(--icon-xs);
	}

	.chip__remove:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	/* Removing is there when the rule is in use (hover, focus); always on touch screens. */
	.rule__remove {
		margin-inline-start: auto;
		opacity: 0;
		transition: opacity 120ms;
	}

	.rule:hover .rule__remove,
	.rule:focus-within .rule__remove {
		opacity: 1;
	}

	@media (hover: none) {
		.rule__remove {
			opacity: 1;
		}
	}

	.rule__problem {
		margin: 0;
		padding-inline-start: 6px;
		color: var(--danger);
		font-size: var(--fs-caption);
	}

	@media (prefers-reduced-motion: reduce) {
		.rule__remove {
			transition: none;
		}
	}
</style>
