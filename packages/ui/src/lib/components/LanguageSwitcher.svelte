<script lang="ts">
	import { LL, getLocale, setLocale } from '$i18n/i18n-svelte';
	import type { Locales } from '$i18n/i18n-types';

	const availableLocales: Locales[] = ['en', 'ja'];
	let currentLang = $state<Locales>(getLocale());

	async function switchLanguage(lang: string) {
		// Save to server-side cookie via API (not affected by Safari ITP 7-day limit)
		try {
			await fetch('/api/set-language', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ language: lang })
			});

			// Update client-side language tag
			setLocale(lang as Locales);
			currentLang = lang as Locales;

			// Reload page to apply language change across all components
			if (typeof window !== 'undefined') {
				window.location.reload();
			}
		} catch (error) {
			console.error('Failed to set language:', error);
		}
	}
</script>

<div class="flex items-center gap-2">
	<div class="i-heroicons-globe-alt h-4 w-4 text-gray-500"></div>
	<select
		value={currentLang}
		onchange={(e) => switchLanguage(e.currentTarget.value)}
		aria-label="Language"
		class="px-2 py-1 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
	>
		{#each availableLocales as lang (lang)}
			<option value={lang}>
				{lang === 'en' ? $LL.language_english() : $LL.language_japanese()}
			</option>
		{/each}
	</select>
</div>
