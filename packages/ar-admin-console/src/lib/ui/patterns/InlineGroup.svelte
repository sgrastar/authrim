<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Short items on one line that wrap as a group: a name followed by its badges, a list of
	 * roles. Pages use it instead of spacing items with whitespace or margins.
	 */
	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<span class="inline-group">{@render children()}</span>

<style>
	.inline-group {
		display: inline-flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
		vertical-align: middle;
	}
</style>
