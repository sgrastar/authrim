<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { t } from '$lib/i18n/i18n.svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { useBusy } from '../busy/busy';

	/**
	 * Labelled single-line input. `placeholder` shows an example of the expected format, never
	 * the label or an instruction (it disappears as soon as the admin types).
	 */
	interface Props extends Omit<HTMLInputAttributes, 'value' | 'size'> {
		label: string;
		/** Keep the label for screen readers only (the name is shown beside the field). */
		hideLabel?: boolean;
		/** `sm`: a lower box and smaller text, beside other small controls or in a dense row. */
		size?: 'md' | 'sm';
		value?: string;
		hint?: string;
		error?: string;
		/**
		 * Show the length under the field ("12/100" with `maxlength`, otherwise just the count).
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
		hideLabel = false,
		size = 'md',
		value = $bindable(''),
		hint,
		error,
		counter = false,
		id,
		required,
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
	const inputId = $derived(id ?? `field-${uid}`);
	const describedBy = $derived(
		[
			hint ? `${inputId}-hint` : '',
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
	/** URLs, email addresses and phone numbers read left to right, also in right-to-left pages. */
	const latinOnly = $derived(['url', 'email', 'tel'].includes(String(rest.type ?? '')));
</script>

<div
	class="field"
	class:field--sm={size === 'sm'}
	class:has-error={!!error}
	class:is-busy={busy()}
	class:is-changed={isChanged}
>
	<label class="field__label" class:sr-only={hideLabel} for={inputId}>
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="field__req" aria-hidden="true">*</span>{/if}
	</label>
	<input
		class="field__input"
		id={inputId}
		bind:value
		{required}
		{maxlength}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={describedBy}
		dir={latinOnly ? 'ltr' : undefined}
		{...rest}
		readonly={!!readonly || busy()}
	/>
	{#if hint || counter}
		<div class="field__foot">
			{#if hint}<p class="field__hint" id="{inputId}-hint">{hint}</p>{/if}
			{#if counter}
				<p class="field__count" class:is-near={nearLimit} id="{inputId}-count">
					{limit === null ? length : `${length}/${limit}`}
				</p>
			{/if}
		</div>
	{/if}
	{#if error}<p class="field__error" id="{inputId}-error">{error}</p>{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 5px;
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

	.field__input {
		height: var(--control-h);
		padding: 0 10px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
	}

	.field--sm .field__input {
		height: var(--control-h-sm);
		padding: 0 8px;
		font-size: var(--fs-label);
	}

	.field__input::placeholder {
		color: var(--text-muted);
		opacity: 1;
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
