<script lang="ts">
	import type { Snippet } from 'svelte';
	import Card from '#lib/ui/patterns/Card.svelte';

	/** One group of settings in a section: a titled box whose fields are spaced by the form rule. */
	interface Props {
		title: string;
		description?: string;
		children: Snippet;
	}

	let { title, description, children }: Props = $props();
</script>

<Card {title} {description}>
	<div class="fields">{@render children()}</div>
</Card>

<style>
	.fields {
		display: grid;
		gap: var(--space-field);
	}
</style>
