<script lang="ts">
	import type { Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
</script>

<div class="section">{@render children()}</div>

<style>
	.section {
		display: grid;
		gap: var(--space-section);
		min-width: 0;
	}
</style>
