<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';

	/**
	 * The way back from where you are: to the list, to the overview, to the parent. It sits at the
	 * top start, above the heading it leaves (`PageHeader` has a `back` slot for it), while what
	 * moves on or acts sits at the top end. The arrow mirrors in right-to-left layouts. A link
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
	/* The small button's padding (10px) is taken back, so the arrow lines up with the heading below. */
	.back {
		display: inline-flex;
		margin-inline-start: -10px;
	}
</style>
