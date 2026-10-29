<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import TextArea from '../primitives/TextArea.svelte';
	import FieldRow from './FieldRow.svelte';

	/**
	 * A few lines of text in two columns: its name on the start side, the box on the end side (a
	 * FieldRow), as wide as the other controls of the form and three lines tall. For a description,
	 * a note, a short list. Only a long document or a block of JSON keeps its box full width, with
	 * the label above. The name is shown by the row and read with the box (kept as its label,
	 * hidden). Takes what `TextArea` takes; `info` goes behind a "?" next to the name.
	 */
	type Props = Omit<ComponentProps<typeof TextArea>, 'hideLabel'> & {
		/** What the setting does, behind a "?" next to its name. */
		info?: string;
	};

	let { label, required, info, value = $bindable(''), rows = 3, ...rest }: Props = $props();
</script>

<FieldRow {label} {info} required={!!required} plain>
	<TextArea {label} {required} {rows} bind:value hideLabel {...rest} />
</FieldRow>
