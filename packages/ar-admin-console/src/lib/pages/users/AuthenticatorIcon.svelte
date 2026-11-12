<script lang="ts">
	import Icon from '#lib/ui/icons/Icon.svelte';
	import type { IconName } from '#lib/ui/icons/icons.js';

	/**
	 * The mark in front of a sign-in method's name: the maker's logo when the API knows the
	 * authenticator (a data URI, one per light and dark theme), else a generic icon. Decorative,
	 * the name beside it says what it is.
	 */
	interface Props {
		logo?: { light: string | null; dark: string | null } | null;
		/** Shown when there is no logo. */
		fallback: IconName;
	}

	let { logo = null, fallback }: Props = $props();
</script>

<span class="authenticator-icon" aria-hidden="true">
	{#if logo}
		<img class="authenticator-icon__light" src={logo.light ?? logo.dark ?? ''} alt="" />
		<img class="authenticator-icon__dark" src={logo.dark ?? logo.light ?? ''} alt="" />
	{:else}
		<Icon name={fallback} />
	{/if}
</span>

<style>
	.authenticator-icon {
		display: inline-grid;
		flex-shrink: 0;
		place-items: center;
		inline-size: var(--icon-xl);
		block-size: var(--icon-xl);
		color: var(--text-muted);
		--icon-size: var(--icon-xl);
	}

	img {
		inline-size: 100%;
		block-size: 100%;
		object-fit: contain;
	}

	.authenticator-icon__dark,
	:global([data-scheme='dark']) .authenticator-icon__light {
		display: none;
	}

	:global([data-scheme='dark']) .authenticator-icon__dark {
		display: block;
	}
</style>
