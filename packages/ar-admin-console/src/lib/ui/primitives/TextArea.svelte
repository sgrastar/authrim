<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { Snippet } from 'svelte';
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { useBusy } from '../busy/busy';

	interface Props extends Omit<HTMLTextareaAttributes, 'value'> {
		label: string;
		value?: string;
		hint?: string;
		error?: string;
		/** Monospace text for code, JSON and keys. */
		mono?: boolean;
		/** Controls aligned with the label (e.g. a Format button). */
		actions?: Snippet;
		/** Status line under the field, replacing the hint (e.g. "Valid JSON"). */
		status?: Snippet;
		/**
		 * Show the length under the field ("120/500" with `maxlength`, otherwise just the count).
		 * Counts like `maxlength` does, so the number matches where typing stops.
		 */
		counter?: boolean;
		/** Path in the SaveScope draft; once the value differs from the saved one it is marked. */
		field?: string;
		/** Mark as changed explicitly (when `field` cannot express the comparison). */
		changed?: boolean;
	}

	let {
		label,
		value = $bindable(''),
		hint,
		error,
		mono = false,
		rows = 6,
		id,
		required,
		actions,
		status,
		counter = false,
		maxlength,
		readonly,
		field,
		changed,
		...rest
	}: Props = $props();

	const changeMark = useChangeMark();
	const isChanged = $derived(changed ?? changeMark.changed(field, value));

	const busy = useBusy();

	const uid = $props.id();
	const inputId = $derived(id ?? `textarea-${uid}`);
	const describedBy = $derived(
		[
			hint || status ? `${inputId}-hint` : '',
			error ? `${inputId}-error` : '',
			counter ? `${inputId}-count` : ''
		]
			.filter(Boolean)
			.join(' ') || undefined
	);
	const length = $derived(value?.length ?? 0);
	const limit = $derived(typeof maxlength === 'number' && maxlength > 0 ? maxlength : null);
	/** Warn in the last tenth, so the limit is not a surprise. */
	const nearLimit = $derived(limit !== null && length >= Math.ceil(limit * 0.9));
</script>

<div class="field" class:has-error={!!error} class:is-busy={busy()} class:is-changed={isChanged}>
	<div class="field__top">
		<label class="field__label" for={inputId}>
			{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
			{#if required}<span class="field__req" aria-hidden="true">*</span>{/if}
		</label>
		{#if actions}<div class="field__actions">{@render actions()}</div>{/if}
	</div>
	<textarea
		class="field__input"
		class:field__input--mono={mono}
		id={inputId}
		{rows}
		bind:value
		{required}
		{maxlength}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		{...rest}
		readonly={!!readonly || busy()}
	></textarea>
	{#if status || hint || counter}
		<div class="field__foot">
			{#if status}
				<div class="field__hint" id="{inputId}-hint">{@render status()}</div>
			{:else if hint}
				<p class="field__hint" id="{inputId}-hint">{hint}</p>
			{/if}
			{#if counter}
				<p class="field__count" class:is-near={nearLimit} id="{inputId}-count">
					{limit === null ? length : `${length}/${limit}`}
				</p>
			{/if}
		</div>
	{/if}
	{#if error}<p class="field__error" id="{inputId}-error" role="alert">{error}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 5px;
	}

	.field__top {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 10px;
		min-height: 22px;
	}

	.field__label {
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.field__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.field__actions {
		display: flex;
		gap: 6px;
	}

	.field__input {
		min-height: 80px;
		padding: 9px 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		line-height: var(--lh-body);
		resize: vertical;
	}

	.field__input--mono {
		font-family: var(--font-mono);
		font-size: var(--fs-label);
		/* Code reads left to right even in right-to-left pages. */
		direction: ltr;
		text-align: left;
		tab-size: 2;
	}

	.field__input:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	/* Busy: read-only, not disabled, so focus and the text stay where the admin left them. */
	/* Quieter surface and text, not transparency: a read-only field must stay readable (AA). */
	.is-busy .field__input {
		background: var(--bg-subtle);
		color: var(--text-secondary);
		cursor: progress;
	}

	/* Changed, not saved yet: the box takes the change colour. */
	.is-changed .field__input {
		border-color: var(--changed-edge);
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-input);
	}

	.has-error .field__input {
		border-color: var(--danger);
	}

	/* Hint on the start side, count pinned to the end side even when there is no hint. */
	.field__foot {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.field__count {
		flex-shrink: 0;
		margin: 0;
		margin-inline-start: auto;
		color: var(--text-muted);
		font-size: var(--fs-caption);
		font-variant-numeric: tabular-nums;
	}

	.field__count.is-near {
		color: var(--warning-text);
		font-weight: var(--fw-semibold);
	}

	.field__hint,
	.field__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.field__hint {
		color: var(--text-muted);
	}

	.field__error {
		color: var(--danger);
	}
</style>
