<script lang="ts">
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import EnvironmentBanner from '#lib/components/EnvironmentBanner.svelte';
	import type { EnvironmentBannerData } from '#lib/environment-banner.js';

	// The root layout draws the platform's environment banner above its children. The normal Login
	// UI's stores, styles and tenant branding live in `(main)/+layout.svelte`, so a page outside
	// `(main)` loads none of them. The banner is read from the page data (the root layout's own
	// load, which the lite layout may refine), so it also shows on error pages.
	let { children }: { children: Snippet } = $props();

	const banner = $derived(
		(page.data as { environmentBanner?: EnvironmentBannerData | null }).environmentBanner ?? null
	);
</script>

<svelte:head>
	{#if banner?.noindex}
		<meta name="robots" content="noindex, nofollow" />
	{/if}
</svelte:head>

<!-- A statement's text framed in the consent screen draws no banner of its own. -->
{#if banner && !page.route.id?.endsWith('/embed')}
	<EnvironmentBanner
		text={banner.text}
		textLocalizations={banner.textLocalizations}
		locale={banner.locale}
		follow={!page.route.id?.startsWith('/__lite')}
	/>
{/if}
{@render children()}
