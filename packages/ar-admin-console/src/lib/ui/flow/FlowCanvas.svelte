<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Vertical flow diagram: endpoints, edges and steps stacked top to bottom on a fixed-width
	 * column (node width + gutters), so every edge runs through the same centre line.
	 */
	interface Props {
		/** Accessible name of the diagram, e.g. the connection name. */
		label: string;
		/** Direction heading above the diagram ("Sign-in", "Provisioning → Slack"). */
		heading?: string;
		detail?: string;
		children: Snippet;
	}

	let { label, heading, detail, children }: Props = $props();
</script>

<section class="flow-canvas" aria-label={label}>
	{#if heading}
		<p class="flow-canvas__heading">
			{heading}{#if detail}<small>{detail}</small>{/if}
		</p>
	{/if}
	<div class="flow-canvas__track">
		{@render children()}
	</div>
</section>

<style>
	.flow-canvas {
		/* Edges and open add points stack locally. */
		isolation: isolate;
		width: calc(var(--flow-canvas-w) + 2px);
		max-width: 100%;
		padding: 4px 0 20px;
		border: 1px solid var(--border);
		border-radius: var(--radius-panel);
		background: var(--bg-subtle);
	}

	.flow-canvas__heading + .flow-canvas__track {
		padding-top: 0;
	}

	.flow-canvas__heading {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 0;
		padding: 14px 16px 10px;
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		font-weight: var(--fw-semibold);
	}

	.flow-canvas__heading small {
		color: var(--text-muted);
		font-size: var(--fs-overline);
		font-weight: var(--fw-regular);
	}

	.flow-canvas__track {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 0;
		padding: 24px var(--flow-gutter) 0;
	}
</style>
