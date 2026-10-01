<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A data type, or another short fact about an item ("string", "boolean", "string[]"),
	 * after its name. Filled and quiet: information, not a status. Reads left to right in
	 * right-to-left pages too (types are code).
	 */
	interface Props {
		/** In a row that cannot be chosen: fainter. */
		muted?: boolean;
		/** `sm`: several in a narrow row (a list of choices). */
		size?: 'md' | 'sm';
		children: Snippet;
	}

	let { muted = false, size = 'md', children }: Props = $props();
</script>

<span class="type-badge" class:is-muted={muted} class:type-badge--sm={size === 'sm'}
	>{@render children()}</span
>

<style>
	.type-badge {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		padding: 0 6px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-badge);
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: var(--fs-small);
		font-weight: var(--fw-semibold);
		white-space: nowrap;
		unicode-bidi: isolate;
		direction: ltr;
	}

	.type-badge--sm {
		padding: 0 4px;
		font-size: var(--fs-overline);
	}

	.type-badge.is-muted {
		color: var(--text-muted);
	}
</style>
