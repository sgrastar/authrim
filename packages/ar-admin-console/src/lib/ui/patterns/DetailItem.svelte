<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One fact of a DetailList: its label and value. Laid out by the DetailList around it. `end`
	 * puts a control at the end of the row, level with the value: a copy button for a value to
	 * hand on. It sits at the end edge, not right after the text, so the buttons of a list line up.
	 */
	interface Props {
		label: string;
		/** A control at the end of the row (a copy button). */
		end?: Snippet;
		children: Snippet;
	}

	let { label, end, children }: Props = $props();
</script>

<div class="detail">
	<dt>{label}</dt>
	<dd class:has-end={!!end}>
		{#if end}
			<!-- Only with a control at the end is the value wrapped; without one it stays as it was. -->
			<span class="detail__value">{@render children()}</span>
			<span class="detail__end">{@render end()}</span>
		{:else}
			{@render children()}
		{/if}
	</dd>
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

	dd.has-end {
		display: flex;
		gap: var(--space-related);
		align-items: center;
		justify-content: space-between;
	}

	/* Takes what the button leaves, and wraps inside it: a long address never pushes the button off its edge. */
	.detail__value {
		flex: 1 1 0;
		min-width: 0;
	}

	.detail__end {
		display: inline-flex;
		flex-shrink: 0;
	}
</style>
