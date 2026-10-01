<script lang="ts">
	import type { Snippet } from 'svelte';

	/** A child of Columns that takes the whole row (a section heading, a long field, a switch). */
	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="span">{@render children()}</div>

<style>
	.span {
		grid-column: 1 / -1;
		min-width: 0;
	}
</style>
