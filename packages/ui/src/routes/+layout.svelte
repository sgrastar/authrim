<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import { setLanguageTag, availableLanguageTags } from '$lib/paraglide/runtime.js';
	import type { LayoutData } from './$types';

	let { children, data } = $props<{ children: any; data: LayoutData }>();

	// Set language from server-provided data (from cookie)
	if (data.preferredLanguage && availableLanguageTags.includes(data.preferredLanguage as any)) {
		setLanguageTag(data.preferredLanguage as any);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
