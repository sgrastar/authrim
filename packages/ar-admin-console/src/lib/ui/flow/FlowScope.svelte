<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Brackets the steps Authrim runs itself, labelled on the frame ("What Authrim does").
	 * A FlowSequence inside it keeps its "+" points within the frame.
	 */
	interface Props {
		label: string;
		children: Snippet;
	}

	let { label, children }: Props = $props();
</script>

<div class="scope" role="group" aria-label={label}>
	<span class="scope__label" aria-hidden="true">{label}</span>
	<div class="scope__track">
		{@render children()}
	</div>
</div>

<style>
	.scope {
		position: relative;
		width: calc(var(--flow-node-w) + 16px);
		/* No padding top and bottom: the lines run across the frame into the first step and out
		   of the last one (FlowSequence `lead` / `trail`). */
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: min(8px, var(--radius-panel));
	}

	.scope__label {
		position: absolute;
		top: -9px;
		inset-inline-start: 12px;
		padding: 0 6px;
		background: var(--bg-subtle);
		color: var(--text-muted);
		font-size: var(--fs-overline);
		line-height: 18px;
		/* Stays on the frame line; a long label wraps inside the frame width. */
		max-width: calc(100% - 24px);
		overflow-wrap: anywhere;
	}

	.scope__track {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0;
		padding: 0;
	}
</style>
