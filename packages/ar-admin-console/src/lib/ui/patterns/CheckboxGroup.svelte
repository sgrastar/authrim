<script lang="ts" module>
	export interface CheckboxOption {
		value: string;
		label: string;
		description?: string;
	}
</script>

<script lang="ts">
	import Checkbox from '../primitives/Checkbox.svelte';
	import { useChangeMark } from '../save/save-scope';

	/**
	 * A named set of related choices (the permissions of one area) with a heading checkbox that
	 * selects or clears the whole set; it shows a mixed state when only some are chosen. A choice
	 * confirmed with a save button — immediate-effect settings use Toggle. Lay several out with
	 * Columns (`align="stretch"`).
	 */
	interface Props {
		title: string;
		options: readonly CheckboxOption[];
		/** Chosen option values. */
		selected?: string[];
		disabled?: boolean;
		/** Path in the SaveScope draft; each choice that differs from the saved set is marked. */
		field?: string;
	}

	let { title, options, selected = $bindable([]), disabled = false, field }: Props = $props();

	const changeMark = useChangeMark();
	const savedSet = $derived(changeMark.original(field));
	/** Whether this choice is on now but was off when saved, or the other way round. */
	const optionChanged = (value: string) =>
		Array.isArray(savedSet) && savedSet.includes(value) !== selected.includes(value);

	const values = $derived(options.map((option) => option.value));
	const chosen = $derived(values.filter((value) => selected.includes(value)).length);
	const all = $derived(values.length > 0 && chosen === values.length);
	const some = $derived(chosen > 0 && !all);

	function setAll(on: boolean) {
		const others = selected.filter((value) => !values.includes(value));
		selected = on ? [...others, ...values] : others;
	}

	function setOne(value: string, on: boolean) {
		selected = on ? [...selected, value] : selected.filter((other) => other !== value);
	}
</script>

<fieldset class="group">
	<legend class="group__head">
		<Checkbox
			checked={all}
			indeterminate={some}
			{disabled}
			onchange={(event) => setAll(event.currentTarget.checked)}
		>
			{title}
		</Checkbox>
	</legend>
	<div class="group__body">
		{#each options as option (option.value)}
			<Checkbox
				checked={selected.includes(option.value)}
				description={option.description}
				value={option.value}
				changed={optionChanged(option.value)}
				{disabled}
				onchange={(event) => setOne(option.value, event.currentTarget.checked)}
			>
				{option.label}
			</Checkbox>
		{/each}
	</div>
</fieldset>

<style>
	.group {
		display: flex;
		flex-direction: column;
		min-width: 0;
		height: 100%;
		margin: 0;
		padding: 0;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--surface-bg);
		-webkit-backdrop-filter: var(--surface-backdrop);
		backdrop-filter: var(--surface-backdrop);
	}

	/* A legend normally sits on the border; float it so it lays out as the card's head row. */
	.group__head {
		float: left;
		width: 100%;
		padding: 11px 16px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-subtle);
		font-weight: var(--fw-semibold);
	}

	.group__body {
		display: grid;
		clear: both;
		gap: 12px;
		padding: 14px 16px 16px;
	}

	/* The heading carries the weight; the choices under it read as its items. */
	.group__body :global(.checkbox__label) {
		font-weight: var(--fw-regular);
	}
</style>
