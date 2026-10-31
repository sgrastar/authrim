<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface SegmentOption {
		value: string;
		label: string;
		icon?: IconName;
		disabled?: boolean;
	}
</script>

<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import Icon from '../icons/Icon.svelte';

	/**
	 * Pick exactly one of a few options, shown as a row of buttons (no radio dots) — view modes,
	 * periods, scopes. Built on native radios, so arrow keys move the choice and assistive tech
	 * announces "1 of 3, selected".
	 */
	interface Props {
		label: string;
		options: readonly SegmentOption[];
		value?: string;
		/** Keep the group label for screen readers only. */
		hideLabel?: boolean;
		/** Stretch segments to fill the width. */
		block?: boolean;
		size?: 'md' | 'sm';
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
		hideLabel = true,
		block = false,
		size = 'md',
		disabled = false,
		onchange,
		field,
		changed
	}: Props = $props();

	const changeMark = useChangeMark();
	const isChanged = $derived(changed ?? changeMark.changed(field, value));

	const busy = useBusy();

	const uid = $props.id();
</script>

<fieldset
	class="segmented segmented--{size}"
	class:segmented--block={block}
	class:is-changed={isChanged}
	disabled={disabled || busy()}
>
	<legend class:sr-only={hideLabel}
		>{label}{#if isChanged}<span class="sr-only"> ({t('common.changed')})</span>{/if}</legend
	>
	<div class="segmented__track">
		{#each options as option (option.value)}
			<label class="segment" class:is-disabled={option.disabled}>
				<input
					type="radio"
					name="segmented-{uid}"
					value={option.value}
					checked={value === option.value}
					disabled={option.disabled}
					onchange={() => {
						value = option.value;
						onchange?.(option.value);
					}}
				/>
				<span class="segment__face">
					{#if option.icon}<Icon name={option.icon} />{/if}
					{option.label}
				</span>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.segmented {
		display: grid;
		gap: 5px;
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		margin-bottom: 4px;
		padding: 0;
		font-size: var(--fs-label);
		font-weight: var(--fw-semibold);
		color: var(--text-secondary);
	}

	.segmented__track {
		display: inline-flex;
		max-width: 100%;
		gap: 2px;
		padding: 2px;
		overflow-x: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--bg-subtle);
	}

	.segmented--block .segmented__track {
		display: flex;
	}

	.segmented--block .segment {
		flex: 1;
	}

	.segment {
		position: relative;
		display: flex;
		cursor: pointer;
	}

	/* Changed, not saved yet: the control takes the change colour. */
	.is-changed .segmented__track {
		background: linear-gradient(var(--changed-bg), var(--changed-bg)), var(--bg-subtle);
		box-shadow: 0 0 0 3px var(--changed-ring);
	}

	.segment.is-disabled,
	.segmented:disabled .segment {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input {
		position: absolute;
		inset: 0;
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}

	.segment__face {
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: 6px;
		/* The track adds 2px padding and a 1px border on each side. */
		height: calc(var(--control-h) - 6px);
		padding: 0 12px;
		border-radius: calc(var(--radius-control) - 2px);
		color: var(--text-secondary);
		font-size: var(--fs-label);
		font-weight: var(--fw-name);
		white-space: nowrap;
		transition:
			background 120ms,
			color 120ms;
		--icon-size: var(--icon-sm);
	}

	.segmented--sm .segment__face {
		height: calc(var(--control-h-sm) - 6px);
		padding: 0 9px;
		font-size: var(--fs-caption);
	}

	/* Labels, not buttons: pressed feedback matches the global button rule. */
	.segmented:not(:disabled) .segment:not(.is-disabled):active .segment__face {
		filter: brightness(0.93);
		translate: 0 1px;
	}

	.segment:hover .segment__face {
		color: var(--text-primary);
	}

	input:checked + .segment__face {
		background: var(--bg-card);
		box-shadow: var(--shadow-sm);
		color: var(--text-primary);
		font-weight: var(--fw-semibold);
	}

	input:focus-visible + .segment__face {
		outline: 2px solid var(--focus-ring);
		outline-offset: 1px;
	}

	@media (prefers-reduced-motion: reduce) {
		.segment__face {
			transition: none;
		}
	}
</style>
