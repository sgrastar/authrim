<script lang="ts">
	import type { Snippet } from 'svelte';

	// The frame (LiteShell) is drawn by each page, which knows its title.
	let { children }: { children: Snippet } = $props();
</script>

{@render children()}
