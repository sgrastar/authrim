<script lang="ts">
	import FieldRow from './FieldRow.svelte';
	import Select from '../primitives/Select.svelte';
	import type { ComponentProps } from 'svelte';

	/**
	 * A dropdown laid out in two columns: its name on the start side, the dropdown on the end
	 * side (a FieldRow), as in the settings pages. The form's own spacing separates the rows, so
	 * it has no dividing lines. The name is shown by the row and read with the dropdown (the
	 * dropdown keeps it as its label, hidden). Narrow screens stack the name over the dropdown.
	 *
	 * Takes what `Select` takes; `info` goes behind a "?" next to the name.
	 */
	type Props = Omit<ComponentProps<typeof Select>, 'hideLabel' | 'info' | 'inline' | 'size'> & {
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
	};

	let { label, required = false, info, value = $bindable(''), ...rest }: Props = $props();
</script>

<FieldRow {label} {info} {required} plain>
	<Select {label} {required} bind:value hideLabel {...rest} />
</FieldRow>
