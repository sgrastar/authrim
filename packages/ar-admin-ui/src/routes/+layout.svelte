<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setLocale } from '$i18n/i18n-svelte';
	import { resolveLocale } from '$i18n/locales';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();

	function setInitialLocale() {
		setLocale(resolveLocale(data.preferredLanguage));
	}

	setInitialLocale();

	// Set language from server-provided data (from cookie)
	$effect.pre(() => {
		const locale = resolveLocale(data.preferredLanguage);
		setLocale(locale);

		if (typeof document !== 'undefined') {
			document.documentElement.lang = locale;
		}
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
