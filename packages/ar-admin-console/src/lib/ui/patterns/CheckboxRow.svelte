<script lang="ts">
	import { t } from '$lib/i18n/i18n.svelte';
	import type { CheckboxOption } from './CheckboxGroup.svelte';
	import Checkbox from '../primitives/Checkbox.svelte';
	import FieldRow from './FieldRow.svelte';

	/**
	 * A few checkboxes in two columns: the name of the choice on the start side, the checkboxes
	 * one under another on the end side (a FieldRow). For a short list of options, each with at
	 * most a line of explanation. The group is named for assistive tech by the row's name.
	 */
	interface Props {
		label: string;
		options: readonly CheckboxOption[];
		/** Chosen option values. */
		selected?: string[];
		/** At least one has to be chosen: a red "*" after the name, and said to assistive tech. */
		required?: boolean;
		/** What to know about the choice, under the checkboxes ("Choose at least one."). */
		hint?: string;
		disabled?: boolean;
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
	}

	let {
		label,
		options,
		selected = $bindable([]),
		required = false,
		hint,
		disabled = false,
		info
	}: Props = $props();

	const uid = $props.id();
	// A hint says what is asked; without one, a required group still says that it is.
	const describedBy = $derived(hint ? `${uid}-hint` : required ? `${uid}-required` : undefined);

	function set(value: string, on: boolean) {
		selected = on ? [...selected, value] : selected.filter((other) => other !== value);
	}
</script>

<FieldRow {label} {info} {required} align="text" plain>
	<div class="checks" role="group" aria-label={label} aria-describedby={describedBy}>
		{#each options as option (option.value)}
			<Checkbox
				checked={selected.includes(option.value)}
				description={option.description}
				value={option.value}
				{disabled}
				onchange={(event) => set(option.value, event.currentTarget.checked)}
			>
				{option.label}
			</Checkbox>
		{/each}
		{#if hint}
			<p class="checks__hint" id="{uid}-hint">{hint}</p>
		{:else if required}
			<span class="sr-only" id="{uid}-required">{t('common.required')}</span>
		{/if}
	</div>
</FieldRow>

<style>
	.checks {
		display: flex;
		flex-direction: column;
		gap: var(--space-related);
	}

	.checks__hint {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
