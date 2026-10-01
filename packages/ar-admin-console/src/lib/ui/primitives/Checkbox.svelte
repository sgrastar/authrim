<script lang="ts">
	import { useChangeMark } from '../save/save-scope';
	import { t } from '$lib/i18n/i18n.svelte';
	import { useBusy } from '../busy/busy';
	import type { Snippet } from 'svelte';
	import Icon from '../icons/Icon.svelte';
	import InfoTip from './InfoTip.svelte';

	/**
	 * Choice confirmed later with a save button. State is not shown by position, so it needs no
	 * mirroring in RTL. Immediate-effect settings use Toggle instead.
	 */
	interface Props {
		checked?: boolean;
		/** Mixed state, e.g. a "select all" box when only some rows are selected. */
		indeterminate?: boolean;
		disabled?: boolean;
		/** Keep the label for screen readers only (table row checkboxes). */
		hideLabel?: boolean;
		name?: string;
		value?: string;
		description?: string;
		/** A longer explanation behind a "?" next to the label, instead of always shown. */
		info?: string;
		onchange?: (event: Event & { currentTarget: HTMLInputElement }) => void;
		children: Snippet;
		/** Path in the SaveScope draft; once the value differs from the saved one it is marked. */
		field?: string;
		/** Mark as changed explicitly (when `field` cannot express the comparison). */
		changed?: boolean;
		/**
		 * How a change shows: `option` washes the whole option (box, label, description) and
		 * rings the box; `box` only rings the box, for a checkbox inside something that carries
		 * the wash itself (a table row, a grid cell). A hidden label always uses `box`.
		 */
		changeMark?: 'option' | 'box';
		/** `sm`: a smaller box and text, for a secondary choice beside a control or a dense list. */
		size?: 'md' | 'sm';
	}

	let {
		checked = $bindable(false),
		indeterminate = false,
		disabled = false,
		hideLabel = false,
		name,
		value,
		description,
		info,
		onchange,
		children,
		field,
		changed,
		changeMark = 'option',
		size = 'md'
	}: Props = $props();

	const changes = useChangeMark();
	const isChanged = $derived(changed ?? changes.changed(field, checked));

	const busy = useBusy();
	const off = $derived(disabled || busy());
	const uid = $props.id();
</script>

{#snippet box()}<label
		class="checkbox"
		class:checkbox--sm={size === 'sm'}
		class:is-disabled={off}
		class:is-changed={isChanged}
		class:mark-option={changeMark === 'option' && !hideLabel}
	>
		<input
			type="checkbox"
			bind:checked
			{indeterminate}
			disabled={off}
			{name}
			{value}
			{onchange}
			aria-describedby={info ? `${uid}-info` : undefined}
		/>
		<span class="checkbox__box" aria-hidden="true">
			<Icon name={indeterminate ? 'minus' : 'check'} />
		</span>
		<span class="checkbox__text" class:sr-only={hideLabel}>
			<span class="checkbox__label"
				>{@render children()}{#if isChanged}<span class="sr-only">
						({t('common.changed')})</span
					>{/if}</span
			>
			{#if description}<span class="checkbox__desc">{description}</span>{/if}
		</span>
	</label>{/snippet}

<!-- The "?" sits beside the label, not in it: a button inside would join the checkbox's name. -->
{#if info}
	<span class="checkbox-info">
		{@render box()}
		<InfoTip label={t('common.moreInfo')} text={info} id="{uid}-info" />
	</span>
{:else}
	{@render box()}
{/if}

<style>
	.checkbox-info {
		display: inline-flex;
		align-items: flex-start;
		gap: 2px;
	}

	.checkbox {
		--box: 20px;
		position: relative;
		display: inline-flex;
		align-items: flex-start;
		gap: 9px;
		cursor: pointer;
	}

	.checkbox--sm {
		--box: 16px;
		gap: 7px;
	}

	.checkbox.is-disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	input {
		position: absolute;
		inset-block-start: 0;
		inset-inline-start: 0;
		width: var(--box);
		height: var(--box);
		margin: 0;
		opacity: 0;
	}

	.checkbox__box {
		display: grid;
		flex-shrink: 0;
		place-items: center;
		width: var(--box);
		height: var(--box);
		border: 1.5px solid var(--border-strong);
		border-radius: min(5px, var(--radius-control));
		background: var(--bg-input);
		color: transparent;
		transition:
			background 120ms,
			border-color 120ms,
			color 120ms;
		--icon-size: var(--icon-sm);
	}

	.checkbox:hover .checkbox__box {
		border-color: var(--primary);
	}

	input:checked + .checkbox__box,
	input:indeterminate + .checkbox__box {
		border-color: var(--primary);
		background: var(--primary);
		color: var(--text-inverse);
	}

	/* Changed, not saved yet: the whole option (box, label, description) takes the change
	   wash — padding and an equal negative margin, so nothing moves — and the box a ring.
	   With changeMark="box" (a table cell, a grid cell) only the ring; its container washes. */
	.checkbox.is-changed.mark-option {
		margin: -5px -8px;
		padding: 5px 8px;
		border-radius: var(--radius-control);
		background: var(--changed-bg);
	}

	.is-changed .checkbox__box {
		box-shadow: 0 0 0 3px var(--changed-ring);
	}

	input:focus-visible + .checkbox__box {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.checkbox__text {
		display: grid;
		gap: 2px;
		padding-top: 1px;
	}

	.checkbox__label {
		font-size: var(--fs-body);
		font-weight: var(--fw-name);
	}

	.checkbox__desc {
		font-size: var(--fs-caption);
		color: var(--text-secondary);
	}

	/* Smaller to look at; the invisible input stays 24px to press (WCAG 2.2 target size). */
	.checkbox--sm input {
		inset-block-start: -4px;
		inset-inline-start: -4px;
		width: 24px;
		height: 24px;
	}

	.checkbox--sm .checkbox__box {
		border-radius: min(4px, var(--radius-control));
		--icon-size: var(--icon-xs);
	}

	.checkbox--sm .checkbox__text {
		padding-top: 0;
	}

	.checkbox--sm .checkbox__label {
		font-size: var(--fs-label);
	}

	.checkbox--sm .checkbox__desc {
		font-size: var(--fs-small);
	}

	@media (prefers-reduced-motion: reduce) {
		.checkbox__box {
			transition: none;
		}
	}
</style>
