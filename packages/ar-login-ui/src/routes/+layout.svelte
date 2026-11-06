<script lang="ts">
	import type { Snippet } from 'svelte';

	// The root layout only renders its children. The normal Login UI's stores, styles and tenant
	// branding live in `(main)/+layout.svelte`, so a page outside `(main)` loads none of them.
	let { children }: { children: Snippet } = $props();
</script>

{@render children()}
