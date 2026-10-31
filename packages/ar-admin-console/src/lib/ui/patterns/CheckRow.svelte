<script lang="ts">
	import Checkbox from '../primitives/Checkbox.svelte';
	import FieldRow from './FieldRow.svelte';

	/**
	 * One checkbox in two columns: the name of the setting on the start side, the checkbox on the
	 * end side with a line saying what it does (a FieldRow). For a yes / no that is confirmed with
	 * Save or a dialog's button; a switch (`ToggleRow`) is only for what takes effect at once.
	 */
	interface Props {
		/** The name of the setting, on the start side. */
		label: string;
		/** What ticking it means, beside the checkbox (the checkbox's own label). */
		text: string;
		/** More about it, under the checkbox. */
		description?: string;
		checked?: boolean;
		disabled?: boolean;
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
		/** Its dotted path in a SaveScope's draft, so it marks itself once changed. */
		field?: string;
	}

	let {
		label,
		text,
		description,
		checked = $bindable(false),
		disabled = false,
		info,
		field
	}: Props = $props();
</script>

<FieldRow {label} {info} align="text" plain>
	<Checkbox bind:checked {disabled} {description} {field}>{text}</Checkbox>
</FieldRow>
