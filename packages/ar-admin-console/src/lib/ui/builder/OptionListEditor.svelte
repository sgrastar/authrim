<script lang="ts" module>
	export interface ChoiceItem {
		/** What is stored when this option is chosen. */
		value: string;
		/** What people see (translatable). */
		label: string;
		/**
		 * A stable identity, for what is kept beside the option (its translations): it stays the
		 * same when the value or the label is edited or the option moves. Added options get one.
		 */
		key?: string;
	}
</script>

<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * The options of a select or a group of radio buttons: each with the label people see and
	 * the value that is stored. Reorder with the arrows, add and remove freely; a value used
	 * twice is flagged, since the stored data could not tell those options apart.
	 * Inside a SaveScope (`field`), the list is marked once it differs from the saved one.
	 */
	interface Props {
		label?: string;
		options?: ChoiceItem[];
		field?: string;
		/** Shown, not edited (no permission to change it). */
		disabled?: boolean;
		/** The longest value and label that can be typed. */
		valueMaxLength?: number;
		labelMaxLength?: number;
		/**
		 * What is wrong with the options, said in place of the hint; `invalid` marks the values it
		 * is about (their fields are invalid and point at it).
		 */
		error?: string;
		invalid?: (value: string) => boolean;
	}

	let {
		label = t('options.legend'),
		options = $bindable([]),
		field,
		disabled = false,
		valueMaxLength,
		labelMaxLength,
		error,
		invalid
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const changed = $derived(changes.changed(field, options));

	/** Values used more than once (each listed once). */
	const duplicates = $derived.by(() => {
		const values = options.map((option) => option.value.trim()).filter(Boolean);
		return values
			.filter((value, index) => values.indexOf(value) !== index)
			.filter((value, index, twice) => twice.indexOf(value) === index);
	});

	const nameOf = (option: ChoiceItem, index: number) =>
		option.label.trim() || t('options.item', { n: index + 1 });

	function update(index: number, patch: Partial<ChoiceItem>) {
		options = options.map((option, i) => (i === index ? { ...option, ...patch } : option));
	}

	function move(index: number, by: -1 | 1) {
		const to = index + by;
		if (to < 0 || to >= options.length) return;
		const next = [...options];
		[next[index], next[to]] = [next[to], next[index]];
		options = next;
	}

	function add() {
		let n = options.length + 1;
		while (options.some((option) => option.value === `option_${n}`)) n++;
		options = [...options, { value: `option_${n}`, label: '', key: crypto.randomUUID() }];
	}
</script>

<fieldset class="options" class:is-changed={changed}>
	<legend
		>{label}{#if changed}<span class="sr-only"> ({t('common.changed')})</span>{/if}</legend
	>
	{#if options.length > 0}
		<div class="options__head" aria-hidden="true">
			<span>{t('options.text')}</span><span>{t('options.value')}</span>
		</div>
		<ol class="options__list">
			{#each options as option, index (index)}
				{@const name = nameOf(option, index)}
				{@const bad = duplicates.includes(option.value.trim()) || !!invalid?.(option.value)}
				<li class="options__row">
					<input
						value={option.label}
						maxlength={labelMaxLength}
						aria-label="{t('options.text')} — {t('options.item', { n: index + 1 })}"
						readonly={busy() || disabled}
						oninput={(event) => update(index, { label: event.currentTarget.value })}
					/>
					<input
						class="options__value"
						class:is-duplicate={bad}
						value={option.value}
						maxlength={valueMaxLength}
						aria-label="{t('options.value')} — {name}"
						aria-invalid={bad || undefined}
						aria-describedby={duplicates.length || error ? `${uid}-error` : `${uid}-hint`}
						spellcheck="false"
						autocomplete="off"
						readonly={busy() || disabled}
						oninput={(event) => update(index, { value: event.currentTarget.value })}
					/>
					<span class="options__actions">
						<IconButton
							icon="arrowUp"
							label={t('options.moveUp', { name })}
							disabled={disabled || index === 0}
							onclick={() => move(index, -1)}
						/>
						<IconButton
							icon="arrowDown"
							label={t('options.moveDown', { name })}
							disabled={disabled || index === options.length - 1}
							onclick={() => move(index, 1)}
						/>
						<IconButton
							icon="trash"
							label={t('options.remove', { name })}
							{disabled}
							onclick={() => (options = options.filter((_, i) => i !== index))}
						/>
					</span>
				</li>
			{/each}
		</ol>
	{:else}
		<p class="options__empty">{t('options.empty')}</p>
	{/if}
	{#if duplicates.length}
		<p class="options__error" id="{uid}-error" role="alert">
			{t('options.duplicate', { value: duplicates[0] })}
		</p>
	{:else if error}
		<p class="options__error" id="{uid}-error" role="alert">{error}</p>
	{:else}
		<p class="options__hint" id="{uid}-hint">{t('options.valueHint')}</p>
	{/if}
	<div>
		<Button size="sm" variant="secondary" icon="plus" {disabled} onclick={add}
			>{t('options.add')}</Button
		>
	</div>
</fieldset>

<style>
	.options {
		display: grid;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		margin-bottom: 4px;
		padding: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.options__head,
	.options__row {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px;
	}

	.options__head {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.options__head span:last-child {
		grid-column: 2;
	}

	.options__list {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	input {
		width: 100%;
		min-width: 0;
		height: var(--control-h-dense);
		padding: 0 8px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-body);
	}

	.options__value {
		font-family: var(--font-mono);
		font-size: var(--fs-caption);
	}

	input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input.is-duplicate {
		border-color: var(--danger);
	}

	input[readonly] {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		cursor: progress;
	}

	/* Changed, not saved yet: the inputs take the change colour. */
	.is-changed input:not(.is-duplicate) {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.options__actions {
		display: flex;
		--icon-size: var(--icon-sm);
	}

	.options__empty,
	.options__hint,
	.options__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.options__empty,
	.options__hint {
		color: var(--text-muted);
	}

	.options__error {
		color: var(--danger);
	}
</style>
