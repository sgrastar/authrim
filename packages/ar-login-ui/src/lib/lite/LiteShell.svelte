<script lang="ts">
	import type { Snippet } from 'svelte';
	import LITE_CSS from '#lib/lite/lite.css?raw';

	/**
	 * The lite Login UI's page frame: the inline stylesheet (allowed by its hash, lite-guard.ts),
	 * the tenant's logo (a checked data: URI) or its name, and the page.
	 */
	let {
		title,
		brandName,
		logo,
		children
	}: { title: string; brandName: string; logo: string | null; children: Snippet } = $props();

	// A constant stylesheet, never data: its exact text is what the lite CSP allows by hash.
	const styleTag = `<style>${LITE_CSS}</style>`;
</script>

<svelte:head>
	<title>{title}</title>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- a constant, allowed by its CSP hash -->
	{@html styleTag}
	<link rel="icon" href="data:," />
</svelte:head>

<header>
	{#if logo}
		<img src={logo} alt={brandName} />
	{:else}
		<p class="brand">{brandName}</p>
	{/if}
</header>
<main>
	{@render children()}
</main>
