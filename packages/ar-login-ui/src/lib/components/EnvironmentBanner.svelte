<script lang="ts">
	import { onMount } from 'svelte';
	import { environmentBannerText } from '@authrim/ar-lib-core/utils/environment-banner-text';
	import { LL, getLocale } from '$i18n/i18n-svelte';

	/**
	 * The platform's environment notice ("This is the staging environment"): a plain full-width
	 * band above the page. A notice only, not a security control. It has no component style on
	 * purpose: the lite pages' CSP allows only their own hashed stylesheet, so the look is the
	 * constant `.environment-banner` rule in `app.css` and in `lib/lite/lite.css`.
	 *
	 * The text is the one of the page's language: `locale` (what the server rendered in) until the
	 * page is in the browser, then, with `follow`, the language the visitor switches to. The first
	 * browser render still uses `locale`, so it matches the server's HTML.
	 */
	interface Props {
		text: string;
		textLocalizations?: Record<string, string>;
		locale?: string;
		/** Follow the Login UI's language switch (the normal pages; the lite pages have no script). */
		follow?: boolean;
	}
	let { text, textLocalizations = {}, locale, follow = false }: Props = $props();

	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const current = $derived.by(() => {
		if (!follow || !mounted) return locale;
		void $LL;
		return getLocale();
	});
	const shown = $derived(environmentBannerText({ text, textLocalizations }, current));
</script>

{#if shown}
	<div class="environment-banner" role="note">{shown}</div>
{/if}
