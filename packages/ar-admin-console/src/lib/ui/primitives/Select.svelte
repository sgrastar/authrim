<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { useBusy } from '../busy/busy';
	import { t } from '$lib/i18n/i18n.svelte';
	import Icon from '../icons/Icon.svelte';
	import type { ChoiceOption } from './RadioGroup.svelte';

	/**
	 * Dropdown for longer lists or where space is tight. A styled native <select>: platform
	 * pickers on touch devices, type-to-find and full keyboard support for free.
	 */
	interface Props {
		label: string;
		options: readonly ChoiceOption[];
		value?: string;
		/** Adds an empty first option prompting a choice. */
		placeholder?: string | boolean;
		hint?: string;
		error?: string;
		required?: boolean;
		disabled?: boolean;
		/** Keep the label for screen readers only (e.g. inside a toolbar). */
		hideLabel?: boolean;
		size?: 'md' | 'sm';
		/** Label beside the control instead of above it (toolbars, pagination). */
		inline?: boolean;
		onchange?: (value: string) => void;
		/** Path in the SaveScope draft; once the value differs from the saved one it is marked. */
		field?: string;
		/** Mark as changed explicitly (when `field` cannot express the comparison). */
		changed?: boolean;
	}

	let {
		label,
		options,
		value = $bindable(''),
		placeholder,
		hint,
		error,
		required = false,
		disabled = false,
		hideLabel = false,
		size = 'md',
		inline = false,
		onchange,
		field,
		changed
	}: Props = $props();

	const changeMark = useChangeMark();
	const isChanged = $derived(changed ?? changeMark.changed(field, value));

	const busy = useBusy();

	const uid = $props.id();
	const describedBy = $derived(
		[hint ? `${uid}-hint` : '', error ? `${uid}-error` : ''].filter(Boolean).join(' ') || undefined
	);
</script>

<div
	class="select"
	class:has-error={!!error}
	class:select--sm={size === 'sm'}
	class:select--inline={inline}
	class:is-changed={isChanged}
>
	<label class="select__label" class:sr-only={hideLabel} for="{uid}-select">
		{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}
		{#if required}<span class="select__req" aria-hidden="true">*</span>{/if}
	</label>
	<div class="select__box">
		<select
			id="{uid}-select"
			bind:value
			{required}
			disabled={disabled || busy()}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={describedBy}
			onchange={() => onchange?.(value)}
		>
			{#if placeholder}
				<option value="" disabled={required}>
					{typeof placeholder === 'string' ? placeholder : t('select.placeholder')}
				</option>
			{/if}
			{#each options as option (option.value)}
				<option value={option.value} disabled={option.disabled}>{option.label}</option>
			{/each}
		</select>
		<span class="select__caret" aria-hidden="true"><Icon name="caret" /></span>
	</div>
	{#if hint}<p class="select__hint" id="{uid}-hint">{hint}</p>{/if}
	{#if error}<p class="select__error" id="{uid}-error">{error}</p>{/if}
</div>

<style>
	.select {
		display: grid;
		gap: 5px;
	}

	.select--inline {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.select--inline .select__label {
		font-size: var(--fs-caption);
		font-weight: var(--fw-medium);
		white-space: nowrap;
	}

	.select__label {
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.select__req {
		margin-inline-start: 3px;
		color: var(--danger);
	}

	.select__box {
		position: relative;
	}

	select {
		width: 100%;
		height: var(--control-h);
		padding-block: 0;
		padding-inline: 10px 32px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: var(--fs-control);
		appearance: none;
		cursor: pointer;
	}

	.select--sm select {
		height: var(--control-h-sm);
		font-size: var(--fs-label);
	}

	/* Changed, not saved yet: the box takes the change colour. */
	.is-changed select {
		border-color: var(--changed-edge);
		background-image: linear-gradient(var(--changed-bg), var(--changed-bg));
	}

	select:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	select:focus-visible {
		border-color: var(--focus-ring);
		outline: 2px solid color-mix(in srgb, var(--focus-ring) 35%, transparent);
		outline-offset: 0;
	}

	.has-error select {
		border-color: var(--danger);
	}

	.select__caret {
		position: absolute;
		top: 50%;
		inset-inline-end: 10px;
		display: inline-flex;
		color: var(--text-muted);
		pointer-events: none;
		transform: translateY(-50%);
		--icon-size: var(--icon-sm);
	}

	.select__hint,
	.select__error {
		margin: 0;
		font-size: var(--fs-caption);
	}

	.select__hint {
		color: var(--text-muted);
	}

	.select__error {
		color: var(--danger);
	}
</style>
