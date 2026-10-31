<script lang="ts">
	/** A titled list of specimens on the themed page background. */
	import type { Snippet } from 'svelte';
	import LoginUIFrame from './LoginUIFrame.svelte';

	let { children, intro = '' }: { children: Snippet; intro?: string } = $props();
</script>

<LoginUIFrame>
	{#if intro}
		<p class="sb-catalog-intro">{intro}</p>
	{/if}
	{@render children()}
</LoginUIFrame>

<style>
	.sb-catalog-intro {
		margin: 0 0 8px;
		font: 0.8125rem/1.5 var(--font-body);
		color: var(--text-secondary);
		max-width: 70ch;
	}
</style>
