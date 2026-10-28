<script lang="ts">
	import FieldRow from './FieldRow.svelte';
	import Toggle from '../primitives/Toggle.svelte';

	/**
	 * An on/off setting in two columns: its name on the start side, the switch on the end side with
	 * a line saying what on means (a FieldRow). The line is what makes the switch understood: say
	 * what happens when it is on, not the setting's name again.
	 */
	interface Props {
		label: string;
		/** What happens when it is on. */
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
	}

	let { label, description, checked = $bindable(false), disabled = false, info }: Props = $props();
	const uid = $props.id();
</script>

<FieldRow {label} {info} align="text" plain>
	<div class="toggle">
		<Toggle
			{label}
			bind:checked
			{disabled}
			describedBy={description ? `${uid}-description` : undefined}
		/>
		{#if description}<span class="toggle__text" id="{uid}-description">{description}</span>{/if}
	</div>
</FieldRow>

<style>
	.toggle {
		display: flex;
		gap: var(--space-grid);
		align-items: center;
	}

	.toggle__text {
		color: var(--text-secondary);
		font-size: var(--fs-small);
	}
</style>
