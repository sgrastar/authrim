<script lang="ts">
	import type { Snippet } from 'svelte';
	import Card from '#lib/ui/patterns/Card.svelte';

	/**
	 * One group of settings in a section: a titled box whose fields are spaced by the form rule.
	 * What the group is for sits behind a "?" beside the title, to keep the narrow inspector short.
	 */
	interface Props {
		title: string;
		info?: string;
		children: Snippet;
	}

	let { title, info, children }: Props = $props();
</script>

<Card {title} {info}>
	<div class="fields">{@render children()}</div>
</Card>

<style>
	.fields {
		display: grid;
		gap: var(--space-field);
	}
</style>
