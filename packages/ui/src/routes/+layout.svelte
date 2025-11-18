<script lang="ts">
	import 'virtual:uno.css';
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';
	import {
		setLanguageTag,
		availableLanguageTags,
		type AvailableLanguageTag
	} from '$lib/paraglide/runtime.js';
	import type { LayoutData } from './$types';
	import type { Snippet } from 'svelte';

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();

	// Set language from server-provided data (from cookie)
	if (
		data.preferredLanguage &&
		availableLanguageTags.includes(data.preferredLanguage as AvailableLanguageTag)
	) {
		setLanguageTag(data.preferredLanguage as AvailableLanguageTag);
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
