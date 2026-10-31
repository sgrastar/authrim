<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Connector between two parts of a flow: an animated dashed line ending in an arrow. A step
	 * that can be inserted here (FlowAddPoint) sits on the line as `children`; the point is part
	 * of the layout, so when it opens into its menu the edge grows and everything below moves
	 * down with it.
	 */
	interface Props {
		/** Minimum line length in px. */
		length?: number;
		/** Arrow at the end. Off for a line that continues into a frame (FlowScope). */
		tip?: boolean;
		children?: Snippet;
	}

	let { length = 28, tip = true, children }: Props = $props();
</script>

<div class="edge" style:--edge-length="{length}px" aria-hidden={children ? undefined : 'true'}>
	<span class="edge__line" class:edge__line--open={!tip}></span>
	{#if tip}<span class="edge__tip"></span>{/if}
	{#if children}<div class="edge__point">{@render children()}</div>{/if}
</div>

<style>
	.edge {
		position: relative;
		display: grid;
		place-items: center;
		width: 100%;
		min-height: var(--edge-length);
	}

	/* Dashes drawn as a repeating gradient so they can flow downward without SVG. */
	.edge__line {
		position: absolute;
		top: 0;
		bottom: 5px;
		left: 50%;
		width: 1.4px;
		background: repeating-linear-gradient(to bottom, var(--text-muted) 0 3px, transparent 3px 7px);
		background-size: 100% 7px;
		transform: translateX(-50%);
		animation: edge-flow 900ms linear infinite;
	}

	.edge__line--open {
		bottom: 0;
	}

	@keyframes edge-flow {
		to {
			background-position: 0 7px;
		}
	}

	.edge__tip {
		position: absolute;
		inset-block-end: 0;
		left: 50%;
		width: 0;
		height: 0;
		border-top: 5px solid var(--text-muted);
		border-left: 3.5px solid transparent;
		border-right: 3.5px solid transparent;
		transform: translateX(-50%);
	}

	/* In the layout (not floating), with room above and below for the line to show. */
	.edge__point {
		position: relative;
		z-index: 3;
		padding-block: 16px;
	}

	.edge__point:has(:global(.add.is-open)) {
		z-index: 20;
	}

	@media (prefers-reduced-motion: reduce) {
		.edge__line {
			animation: none;
		}
	}
</style>
