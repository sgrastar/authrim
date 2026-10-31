<script lang="ts" module>
	export interface KeyValue {
		key: string;
		value: string;
	}
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import IconButton from '../primitives/IconButton.svelte';
	import { useChangeMark, useInvalidReport } from '../save/save-scope';
	import { duplicateIndexes } from './list-input';

	/**
	 * Pairs of a key and a value: request headers, claim mappings, extra parameters. Keys are
	 * monospace and must be unique (a repeat is flagged on the later one); `validateKey` /
	 * `validateValue` add the page's own rules. A row whose key and value are both emptied is
	 * dropped when focus leaves it. Inside a SaveScope (`field`) the whole list is marked once it
	 * differs from the saved one.
	 */
	interface Props {
		label: string;
		entries?: KeyValue[];
		keyLabel?: string;
		valueLabel?: string;
		/** Shapes of one entry ("X-Request-Id", "{{user.id}}"). */
		keyPlaceholder?: string;
		valuePlaceholder?: string;
		hint?: string;
		addLabel?: string;
		validateKey?: (key: string) => string | undefined;
		validateValue?: (value: string, key: string) => string | undefined;
		disabled?: boolean;
		invalid?: boolean;
		field?: string;
		changed?: boolean;
	}

	let {
		label,
		entries = $bindable([]),
		keyLabel = t('kv.key'),
		valueLabel = t('kv.value'),
		keyPlaceholder,
		valuePlaceholder,
		hint,
		addLabel = t('list.add'),
		validateKey,
		validateValue,
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
	const isChanged = $derived(changed ?? changes.changed(field, entries));
	const off = $derived(disabled || busy());
	let list = $state<HTMLOListElement>();

	const repeated = $derived(duplicateIndexes(entries.map((entry) => entry.key)));
	const problems = $derived(
		entries.map((entry, index) => {
			const key = entry.key.trim();
			if (repeated.has(index)) return t('kv.duplicate', { key });
			if (!key && !entry.value.trim()) return undefined;
			return (
				(key ? validateKey?.(key) : undefined) ??
				(entry.value.trim() ? validateValue?.(entry.value.trim(), key) : undefined)
			);
		})
	);
	$effect(() => {
		invalid = problems.some(Boolean);
	});

	const rowName = (index: number) =>
		entries[index]?.key.trim() || t('list.item', { label, n: index + 1 });

	function update(index: number, patch: Partial<KeyValue>) {
		entries = entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry));
	}

	async function add() {
		entries = [...entries, { key: '', value: '' }];
		await tick();
		list?.querySelectorAll<HTMLInputElement>('.kv__key')[entries.length - 1]?.focus();
	}

	/** Drops a row left completely empty once focus leaves it. */
	function tidy(index: number, event: FocusEvent) {
		const row = (event.currentTarget as HTMLElement).closest('li');
		if (row?.contains(event.relatedTarget as Node | null)) return;
		const entry = entries[index];
		if (entry && !entry.key.trim() && !entry.value.trim()) {
			entries = entries.filter((_, i) => i !== index);
		}
	}
</script>

<fieldset class="kv" class:is-changed={isChanged} {disabled}>
	<legend class="kv__label">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
	</legend>
	{#if entries.length > 0}
		<div class="kv__head" aria-hidden="true"><span>{keyLabel}</span><span>{valueLabel}</span></div>
		<ol class="kv__rows" bind:this={list}>
			{#each entries as entry, index (index)}
				<li>
					<div class="kv__row">
						<input
							class="kv__key"
							class:has-error={!!problems[index]}
							dir="ltr"
							value={entry.key}
							placeholder={keyPlaceholder}
							aria-label="{keyLabel} — {t('list.item', { label, n: index + 1 })}"
							aria-invalid={problems[index] ? 'true' : undefined}
							aria-describedby={problems[index] ? `${uid}-error-${index}` : undefined}
							spellcheck="false"
							autocomplete="off"
							readonly={busy()}
							oninput={(event) => update(index, { key: event.currentTarget.value })}
							onblur={(event) => tidy(index, event)}
						/>
						<input
							class="kv__value"
							value={entry.value}
							placeholder={valuePlaceholder}
							aria-label="{valueLabel} — {rowName(index)}"
							spellcheck="false"
							autocomplete="off"
							readonly={busy()}
							oninput={(event) => update(index, { value: event.currentTarget.value })}
							onblur={(event) => tidy(index, event)}
						/>
						<IconButton
							icon="trash"
							label={t('list.remove', { name: rowName(index) })}
							disabled={off}
							onclick={() => (entries = entries.filter((_, i) => i !== index))}
						/>
					</div>
					{#if problems[index]}
						<p class="kv__error" id="{uid}-error-{index}">{problems[index]}</p>
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="kv__note">{t('list.empty')}</p>
	{/if}
	{#if hint}<p class="kv__note">{hint}</p>{/if}
	<div>
		<Button size="sm" variant="secondary" icon="plus" disabled={off} onclick={add}
			>{addLabel}</Button
		>
	</div>
</fieldset>

<style>
	.kv {
		display: grid;
		gap: 6px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.kv__label {
		margin-bottom: 4px;
		padding: 0;
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
	}

	.kv__head,
	.kv__row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) var(--control-h-dense);
		align-items: center;
		gap: 6px;
	}

	.kv__head {
		color: var(--text-muted);
		font-size: var(--fs-small);
	}

	.kv__rows {
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
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
	}

	.kv__key {
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

	.kv__note,
	.kv__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.kv__note {
		color: var(--text-muted);
	}

	.kv__error {
		margin-top: 3px;
		color: var(--danger);
	}
</style>
