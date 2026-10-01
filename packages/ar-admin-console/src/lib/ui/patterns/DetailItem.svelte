<script lang="ts">
	import type { Snippet } from 'svelte';

	/** One fact of a DetailList: its label and value. Laid out by the DetailList around it. */
	interface Props {
		label: string;
		children: Snippet;
	}

	let { label, children }: Props = $props();
</script>

<div class="detail">
	<dt>{label}</dt>
	<dd>{@render children()}</dd>
</div>

<style>
	dt {
		color: var(--text-muted);
	}

	dd {
		min-width: 0;
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
