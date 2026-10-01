<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Page body. Two widths, both start-aligned so the content edge does not move when the left
	 * nav appears or disappears:
	 *   standard — settings and forms: lines stay short, labels stay close to their controls
	 *   wide     — lists, tables, logs, dashboards: wide screens show more columns
	 * Children reveal top to bottom when the page is entered.
	 */
	interface Props {
		width?: 'standard' | 'wide';
		reveal?: boolean;
		children: Snippet;
	}

	let { width = 'standard', reveal = true, children }: Props = $props();
</script>

<div class="page" class:page--wide={width === 'wide'} data-reveal={reveal ? 'on' : undefined}>
	{@render children()}
</div>

<style>
	.page {
		display: grid;
		gap: var(--space-section);
		max-width: var(--page-w-standard);
		padding: var(--space-page-top) var(--space-page-x) var(--space-page-bottom);
	}

	.page > :global(*) {
		min-width: 0;
	}

	.page--wide {
		max-width: var(--page-w-wide);
	}
</style>
