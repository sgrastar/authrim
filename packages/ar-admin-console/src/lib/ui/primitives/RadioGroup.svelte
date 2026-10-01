<script lang="ts" module>
	export interface ChoiceOption {
		value: string;
		label: string;
		description?: string;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	/**
	 * One choice from a short list where every option should stay visible (up to ~5). Longer
	 * lists use Select; compact toolbars use SegmentedControl. Native radios, so arrow keys move
	 * the selection.
	 */
	interface Props {
		label: string;
		options: readonly ChoiceOption[];
		value?: string;
		name?: string;
		orientation?: 'vertical' | 'horizontal';
		disabled?: boolean;
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
		name,
		orientation = 'vertical',
		disabled = false,
		onchange,
		field,
		changed
	}: Props = $props();

	const changeMark = useChangeMark();
	const isChanged = $derived(changed ?? changeMark.changed(field, value));

	const busy = useBusy();

	const uid = $props.id();
	const groupName = $derived(name ?? `radio-${uid}`);
</script>

<fieldset
	class="radios radios--{orientation}"
	class:is-changed={isChanged}
	disabled={disabled || busy()}
>
	<legend class="radios__legend"
		>{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}</legend
	>
	{#each options as option (option.value)}
		<label class="radio" class:is-disabled={option.disabled}>
			<input
				type="radio"
				name={groupName}
				value={option.value}
				checked={value === option.value}
				disabled={option.disabled}
				onchange={() => {
					value = option.value;
					onchange?.(option.value);
				}}
			/>
			<span class="radio__dot" aria-hidden="true"></span>
			<span class="radio__text">
				<span class="radio__label">{option.label}</span>
				{#if option.description}<span class="radio__desc">{option.description}</span>{/if}
			</span>
		</label>
	{/each}
</fieldset>

<style>
	.radios {
		display: grid;
		gap: 10px;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.radios--horizontal {
		display: flex;
		flex-wrap: wrap;
		gap: 10px 20px;
	}

	.radios--horizontal .radios__legend {
		width: 100%;
	}

	.radios__legend {
		margin-bottom: 4px;
		padding: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.radio {
		position: relative;
		display: inline-flex;
		align-items: flex-start;
		gap: 9px;
		cursor: pointer;
	}

	/* Changed, not saved yet: the new choice takes the change wash, its dot a ring. */
	.is-changed .radio:has(input:checked) {
		margin: -5px -8px;
		padding: 5px 8px;
		border-radius: var(--radius-control);
		background: var(--changed-bg);
	}

	.is-changed input:checked + .radio__dot {
		box-shadow: 0 0 0 3px var(--changed-ring);
	}

	.radio.is-disabled,
	.radios:disabled .radio {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input {
		position: absolute;
		inset-block-start: 0;
		inset-inline-start: 0;
		width: 20px;
		height: 20px;
		margin: 0;
		opacity: 0;
	}

	.radio__dot {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: 20px;
		height: 20px;
		border: 1.5px solid var(--border-strong);
		border-radius: 50%;
		background: var(--bg-input);
		transition: border-color 120ms;
	}

	.radio__dot::after {
		content: '';
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--primary);
		transform: scale(0);
		transition: transform 120ms;
	}

	.radio:hover .radio__dot {
		border-color: var(--primary);
	}

	input:checked + .radio__dot {
		border-color: var(--primary);
	}

	input:checked + .radio__dot::after {
		transform: scale(1);
	}

	input:focus-visible + .radio__dot {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.radio__text {
		display: grid;
		gap: 2px;
		padding-top: 1px;
	}

	.radio__label {
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
	}

	.radio__desc {
		font-size: var(--fs-caption);
		color: var(--text-secondary);
	}

	@media (prefers-reduced-motion: reduce) {
		.radio__dot,
		.radio__dot::after {
			transition: none;
		}
	}
</style>
