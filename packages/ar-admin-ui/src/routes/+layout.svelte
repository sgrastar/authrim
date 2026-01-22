<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setLocale } from '$i18n/i18n-svelte';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();

	// Set language from server-provided data (from cookie)
	if (
		data.preferredLanguage &&
		(data.preferredLanguage === 'en' || data.preferredLanguage === 'ja')
	) {
		setLocale(data.preferredLanguage);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
