<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Page body. One start-aligned width keeps the frame consistent across pages and when the
	 * left navigation appears or disappears. It shrinks with the viewport on smaller screens.
	 * Children reveal top to bottom when the page is entered.
	 *
	 * `withFlow`: a flow diagram sits beside the settings (a service flow's page), and the left
	 * navigation is hidden, so the frame starts at the screen's edge. It is wider by the width of
	 * the navigation, which puts its right edge where every other page's frame ends.
	 */
	interface Props {
		reveal?: boolean;
		withFlow?: boolean;
		children: Snippet;
	}

	let { reveal = true, withFlow = false, children }: Props = $props();
</script>

<div class="page" class:page--flow={withFlow} data-reveal={reveal ? 'on' : undefined}>
	{@render children()}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-section);
		max-width: var(--page-w);
		padding: var(--space-page-top) var(--space-page-x) var(--space-page-bottom);
	}

	.page--flow {
		max-width: calc(var(--page-w) + var(--sidebar-w));
	}

	.page > :global(*) {
		min-width: 0;
	}
</style>
