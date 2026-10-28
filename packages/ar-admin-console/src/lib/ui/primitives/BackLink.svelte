<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	/**
	 * The way back from where you are: to the list, to the overview, to the parent. It sits at the
	 * top start, above the heading it leaves (`PageHeader` has a `back` slot for it), while what
	 * moves on or acts sits at the top end. It always shows its frame (the surface a ghost button only
	 * gets on hover), so it reads as a control. The arrow mirrors in right-to-left layouts. A link
	 * when it leads to a page (`href`), a button when it only changes what is shown (`onclick`).
	 */
	interface Props {
		href?: string;
		onclick?: () => void;
		children: Snippet;
	}

	let { href, onclick, children }: Props = $props();
</script>

<span class="back">
	<Button variant="ghost" size="sm" icon="arrowBack" {href} {onclick}>{@render children()}</Button>
</span>

<style>
	/*
	 * Always framed: a quiet surface and an outline, the look a ghost button only gets on hover,
	 * so it reads as something to press and not as a caption. It sits flush with the heading
	 * below (no negative margin: the frame's own edge is what lines up).
	 */
	.back {
		display: inline-flex;
	}

	.back :global(.btn) {
		border-color: var(--border);
		background: var(--bg-hover);
	}

	.back :global(.btn:hover:not(:disabled, [aria-busy='true'])) {
		background: var(--bg-press);
	}
</style>
