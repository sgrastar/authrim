<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A table cell with more than one line: the name, a short description under it, and
	 * optionally one more line (a link to the related settings). Keeps the row readable when
	 * the name alone would not say what the row is.
	 */
	interface Props {
		title: string;
		description?: string;
		/** An extra line under the description, e.g. a Link. */
		children?: Snippet;
	}

	let { title, description, children }: Props = $props();
</script>

<span class="cell-text">
	<strong>{title}</strong>
	{#if description}<span class="cell-text__desc">{description}</span>{/if}
	{#if children}<span class="cell-text__extra">{@render children()}</span>{/if}
</span>

<style>
	.cell-text {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	strong {
		color: var(--text-primary);
		font-size: var(--fs-body);
		font-weight: var(--fw-semibold);
	}

	.cell-text__desc {
		color: var(--text-secondary);
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
	}

	.cell-text__extra {
		margin-top: 2px;
		font-size: var(--fs-caption);
	}
</style>
