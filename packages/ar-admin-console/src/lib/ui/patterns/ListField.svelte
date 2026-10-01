<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { duplicateIndexes, splitLines } from './list-input';

	/**
	 * A list of single values: redirect URIs, allowed origins, IP ranges, domains.
	 * - One box per value; "Add" appends a box and moves focus into it.
	 * - Pasting several lines into a box adds one entry per line, so a list copied from
	 *   elsewhere goes in at once.
	 * - A box left empty is dropped when focus leaves it (the list never saves blanks).
	 * - Each entry is checked with `validate` and against the others (a value twice is
	 *   flagged); problems show under the entry and `invalid` tells the page.
	 * - Inside a SaveScope (`field`), the list is marked once it differs from the saved one.
	 */
	interface Props {
		label: string;
		values?: string[];
		/** The shape of one entry ("https://example.com/callback"). */
		placeholder?: string;
		hint?: string;
		/** Label of the add button; defaults to "Add". */
		addLabel?: string;
		/** Monospace entries (URIs, CIDRs, keys). */
		mono?: boolean;
		/** Returns a problem with one entry, or nothing. */
		validate?: (value: string) => string | undefined;
		max?: number;
		required?: boolean;
		disabled?: boolean;
		invalid?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		values = $bindable([]),
		placeholder,
		hint,
		addLabel = t('list.add'),
		mono = false,
		validate,
		max,
		required = false,
		disabled = false,
		invalid = $bindable(false),
		field,
		changed
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const report = useInvalidReport();
	$effect(() => report(invalid));
	const isChanged = $derived(changed ?? changes.changed(field, values));
	const off = $derived(disabled || busy());
	let list = $state<HTMLOListElement>();

	const repeated = $derived(duplicateIndexes(values));
	const problems = $derived(
		values.map((value, index) =>
			repeated.has(index)
				? t('list.duplicate')
				: value.trim()
					? validate?.(value.trim())
					: undefined
		)
	);
	$effect(() => {
		invalid = problems.some(Boolean);
	});

	const itemLabel = (index: number) => t('list.item', { label, n: index + 1 });
	const full = $derived(max !== undefined && values.length >= max);

	async function focusRow(index: number) {
		await tick();
		list?.querySelectorAll<HTMLInputElement>('input')[index]?.focus();
	}

	function add() {
		if (full) return;
		values = [...values, ''];
		focusRow(values.length - 1);
	}

	function remove(index: number) {
		values = values.filter((_, i) => i !== index);
		focusRow(Math.min(index, values.length - 1));
	}

	function paste(event: ClipboardEvent, index: number) {
		const lines = splitLines(event.clipboardData?.getData('text') ?? '');
		if (lines.length < 2) return;
		event.preventDefault();
		const room = max === undefined ? lines.length : Math.max(1, max - values.length + 1);
		values = [...values.slice(0, index), ...lines.slice(0, room), ...values.slice(index + 1)];
		focusRow(index + Math.min(lines.length, room) - 1);
	}

	/** An emptied box goes away when focus leaves it (unless it is the only one). */
	function tidy(index: number) {
		if (values[index]?.trim() === '' && values.length > 1) {
			values = values.filter((_, i) => i !== index);
		} else if (values[index] !== undefined && values[index] !== values[index].trim()) {
			values = values.map((value, i) => (i === index ? value.trim() : value));
		}
	}
</script>

<fieldset class="list" class:is-changed={isChanged} {disabled}>
	<legend class="list__label">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="list__req" aria-hidden="true">*</span>{/if}
	</legend>
	{#if values.length > 0}
		<ol class="list__rows" bind:this={list}>
			{#each values as value, index (index)}
				<li class="list__row">
					<div class="list__line">
						<input
							class:is-mono={mono}
							class:has-error={!!problems[index]}
							dir={mono ? 'ltr' : undefined}
							{value}
							{placeholder}
							aria-label={itemLabel(index)}
							aria-invalid={problems[index] ? 'true' : undefined}
							aria-describedby={problems[index] ? `${uid}-error-${index}` : `${uid}-hint`}
							spellcheck="false"
							autocomplete="off"
							readonly={busy()}
							oninput={(event) =>
								(values = values.map((v, i) => (i === index ? event.currentTarget.value : v)))}
							onpaste={(event) => paste(event, index)}
							onblur={() => tidy(index)}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									add();
								}
							}}
						/>
						<IconButton
							icon="trash"
							label={t('list.remove', { name: value.trim() || itemLabel(index) })}
							disabled={off}
							onclick={() => remove(index)}
						/>
					</div>
					{#if problems[index]}
						<p class="list__error" id="{uid}-error-{index}">{problems[index]}</p>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="list__empty">{t('list.empty')}</p>
	{/if}
	<p class="list__hint" id="{uid}-hint">{hint ? `${hint} ` : ''}{t('list.pasteHint')}</p>
	<div>
		<Button size="sm" variant="secondary" icon="plus" disabled={off || full} onclick={add}>
			{addLabel}
		</Button>
	</div>
</fieldset>

<style>
	.list {
		display: grid;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.list__label {
		margin-bottom: 4px;
		padding: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.list__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.list__rows {
		display: grid;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.list__line {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	input {
		flex: 1;
		min-width: 0;
		height: var(--control-h-dense);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
	}

	input.is-mono {
		font-family: var(--font-mono);
		font-size: var(--fs-body);
	}

	input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	input[readonly] {
		background: var(--bg-subtle);
		cursor: progress;
	}

	.is-changed input:not(.has-error) {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	input.has-error {
		border-color: var(--danger);
	}

	.list__empty,
	.list__hint,
	.list__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.list__empty,
	.list__hint {
		color: var(--text-muted);
	}

	.list__error {
		margin-top: 3px;
		color: var(--danger);
	}
</style>
