<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import TextField from '../primitives/TextField.svelte';
	import FieldRow from './FieldRow.svelte';

	/**
	 * A short text field in two columns: its name on the start side, the field on the end side (a
	 * FieldRow, as in the settings pages). For a value that is short: a name, an ID, a code. A long
	 * value (an address list, a pasted document) keeps the field full width, with its label above.
	 * The name is shown by the row and read with the field (kept as its label, hidden). Takes what
	 * `TextField` takes; `info` goes behind a "?" next to the name.
	 */
	type Props = Omit<ComponentProps<typeof TextField>, 'hideLabel' | 'size'> & {
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
	};

	let { label, required, info, value = $bindable(''), ...rest }: Props = $props();
</script>

<FieldRow {label} {info} required={!!required} plain>
	<TextField {label} {required} bind:value hideLabel {...rest} />
</FieldRow>
