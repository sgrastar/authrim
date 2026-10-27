<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Page body. One start-aligned width keeps the frame consistent across pages and when the
	 * left navigation appears or disappears. It shrinks with the viewport on smaller screens.
	 * Children reveal top to bottom when the page is entered.
	 */
	interface Props {
		reveal?: boolean;
		children: Snippet;
	}

	let { reveal = true, children }: Props = $props();
</script>

<div class="page" data-reveal={reveal ? 'on' : undefined}>
	{@render children()}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-section);
		max-width: var(--page-w);
		padding: var(--space-page-top) var(--space-page-x) var(--space-page-bottom);
	}

	.page > :global(*) {
		min-width: 0;
	}
</style>
